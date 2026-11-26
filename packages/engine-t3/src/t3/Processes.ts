// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  POWERSHELL,
  powerShellArgs,
  powerShellLiteral,
  system32,
  windowsCommandWords,
  windowsNameKey,
  withoutModulePath,
} from "@j3-bots/processes";
import { boundedCommand } from "./Command.ts";

// What the supervisor does to a process it did not start in this run: the
// engine an earlier J3 Bots process started and lost. On Linux and macOS it
// asks `ps` for its command line and signals it. Windows has neither `ps` nor
// signals: its command line comes from the system's process table through
// PowerShell, and the only stop it has is to end the process and every one it
// started (`taskkill /T /F`). T3 Code has no other way to be asked to stop
// there: it stops on SIGTERM and SIGINT only (**Read** at `59651c1`,
// `apps/server/src/cli/server.ts` and `launcherWatch.ts`), and Windows sends
// neither to a process without a console window. Its state is SQLite, which
// survives a process ended mid-write.
//
// A process id names a process only while it runs: once it ends, the system
// may give the id to another. On Windows a process is found by its id and
// when it started, read while a handle to it is held, and Windows gives no
// other process an id while a handle to the one that had it is open. The stop
// holds a handle too, checks that the process still started when it did, and
// ends it while it holds it: a process that took the id in the meantime is
// never stopped. `ps` and `kill` give no such hold, so elsewhere the process
// is found and signalled by its id alone.

/** A running process, as the system named it when it was looked up. */
export type Found =
  | { readonly _tag: "unix"; readonly pid: number; readonly commandLine: string }
  | {
      readonly _tag: "windows";
      readonly pid: number;
      readonly commandLine: string;
      /** When it started: 100 ns ticks since 0001-01-01 UTC, as .NET counts them. */
      readonly started: string;
    };

/**
 * Whether a command line is the engine serving the data directory `home`:
 * its `serve` command with `--base-dir` set to `home`. On Windows the line is
 * split as the engine itself splits it, and paths compare without case, as
 * NTFS compares them (`windowsNameKey`). `ps` joins the words with spaces and does not quote,
 * so on other systems `home` must stand as words of its own after
 * `--base-dir`.
 */
export const servesHome = (platform: string, commandLine: string, home: string): boolean => {
  if (platform === "win32") {
    const words = windowsCommandWords(commandLine);
    const at = words.indexOf("--base-dir");
    const baseDir = at < 0 ? undefined : words[at + 1];
    return (
      words.includes("serve") &&
      baseDir !== undefined &&
      windowsNameKey(baseDir.replace(/[\\/]+$/, "")) === windowsNameKey(home.replace(/[\\/]+$/, ""))
    );
  }
  const words = commandLine.trim().split(/\s+/);
  return words.includes("serve") && ` ${commandLine.trim()} `.includes(` --base-dir ${home} `);
};

const POLL = Duration.millis(250);

/** How long PowerShell gets to answer a lookup: it takes about a second to start. */
const LOOKUP_WITHIN = Duration.seconds(30);

/** What a Windows lookup prints: the start time, a line feed, the command line. */
const decodeWindowsLookup = (pid: number, printed: string): Option.Option<Found> => {
  const at = printed.indexOf("\n");
  const started = at < 0 ? "" : printed.slice(0, at).trim();
  const commandLine = at < 0 ? "" : printed.slice(at + 1).trim();
  return /^\d+$/.test(started) && commandLine !== ""
    ? Option.some({ _tag: "windows", pid, commandLine, started })
    : Option.none();
};

/**
 * Looks at and stops processes by their id on `platform`, which must be the
 * system this runs on, with `environment` its environment (for where
 * PowerShell is on Windows).
 */
export const makeProcesses = Effect.fnUntraced(function* (
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /** Runs a short system command; its exit code, or -1 if it could not run. */
  const exitCode = (executable: string, args: ReadonlyArray<string>) =>
    spawner.exitCode(boundedCommand(executable, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => -1),
    );

  /** Windows PowerShell running `script`, with nothing of this process's but its environment. */
  const powerShell = (script: string, stdout: "pipe" | "ignore") =>
    boundedCommand(
      system32(environment, POWERSHELL),
      powerShellArgs(script),
      {
        stdin: "ignore",
        stdout,
        stderr: "ignore",
        env: withoutModulePath(environment),
        extendEnv: false,
      },
      "15 seconds",
    );

  /**
   * Whether `pid` is a process that runs, by a null signal, which every
   * system Node runs on answers: an error that says no such process is the
   * only `false`. A process this user may not signal still runs.
   */
  const isAlive = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    });

  /**
   * The process `pid` names now, with its command line, if it runs and the
   * system says. On Windows its start time and its command line are read
   * while a handle to it is held, so both are the same process's; one this
   * user may not open is not found.
   */
  const lookUp = (pid: number): Effect.Effect<Option.Option<Found>> => {
    const id = Math.trunc(pid);
    if (platform === "win32") {
      return spawner
        .string(
          powerShell(
            [
              `$process = Get-Process -Id ${id} -ErrorAction SilentlyContinue`,
              "if (-not $process) { exit 3 }",
              "$null = $process.Handle",
              `$found = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${id}'`,
              "if (-not $found -or $null -eq $found.CommandLine) { exit 3 }",
              "[Console]::Out.Write([string]$process.StartTime.ToUniversalTime().Ticks + [char]10 + $found.CommandLine)",
            ].join("\n"),
            "pipe",
          ),
        )
        .pipe(
          Effect.timeoutOption(LOOKUP_WITHIN),
          Effect.map(Option.flatMap((printed) => decodeWindowsLookup(id, printed))),
          Effect.orElseSucceed(() => Option.none()),
        );
    }
    return spawner
      .string(
        boundedCommand("ps", ["-p", String(id), "-o", "args="], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.map((line): Option.Option<Found> =>
          line.trim() === ""
            ? Option.none()
            : Option.some({ _tag: "unix", pid: id, commandLine: line.trim() }),
        ),
        Effect.orElseSucceed(() => Option.none()),
      );
  };

  const waitUntilGone = (pid: number, within: Duration.Duration) =>
    isAlive(pid).pipe(
      Effect.repeat({ schedule: Schedule.spaced(POLL), until: (alive) => !alive }),
      Effect.timeoutOption(within),
      Effect.map(Option.isSome),
    );

  /**
   * Stops the process `found` names, and waits until it is gone, for at most
   * `afterKill` past the last step. Returns whether it is gone. On Linux and
   * macOS: SIGTERM, then SIGKILL once `grace` has passed. On Windows: the
   * process and every one it started, `taskkill /T /F`, run while a handle to
   * it is held and only if it still started when `found` says; a process that
   * has its id now is another one, and is left alone.
   */
  const stop = Effect.fnUntraced(function* (
    found: Found,
    grace: Duration.Duration,
    afterKill: Duration.Duration,
  ) {
    const id = Math.trunc(found.pid);
    switch (found._tag) {
      case "unix":
        yield* exitCode("kill", ["-TERM", String(id)]);
        if (yield* waitUntilGone(id, grace)) return true;
        yield* exitCode("kill", ["-KILL", String(id)]);
        return yield* waitUntilGone(id, afterKill);
      case "windows": {
        const code = yield* spawner
          .exitCode(
            powerShell(
              [
                `$process = Get-Process -Id ${id} -ErrorAction SilentlyContinue`,
                "if (-not $process) { exit 0 }",
                "$null = $process.Handle",
                `if ($process.StartTime.ToUniversalTime().Ticks -ne ${found.started}) { exit 0 }`,
                `& ${powerShellLiteral(system32(environment, "taskkill.exe"))} /PID ${id} /T /F | Out-Null`,
                `if ($process.WaitForExit(${Duration.toMillis(afterKill)})) { exit 0 } else { exit 4 }`,
              ].join("\n"),
              "ignore",
            ),
          )
          .pipe(
            Effect.timeoutOption(Duration.sum(afterKill, LOOKUP_WITHIN)),
            Effect.map(Option.map(Number)),
            Effect.orElseSucceed(() => Option.none<number>()),
          );
        return Option.contains(code, 0);
      }
    }
  });

  return { isAlive, lookUp, stop, waitUntilGone };
});
