// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
// survives a process ended mid-write, and its harnesses are its descendants
// on Windows (no `systemd-run` scope there), so the tree kill ends them too.

/** How a process is asked to stop, then made to. */
export type StopPlan =
  | {
      readonly _tag: "signals";
      /** How long it gets after SIGTERM before SIGKILL. */
      readonly grace: Duration.Duration;
    }
  | { readonly _tag: "tree-kill" };

/** The stop each system allows: signals where there are signals, a tree kill on Windows. */
export const stopPlan = (platform: string, grace: Duration.Duration): StopPlan =>
  platform === "win32" ? { _tag: "tree-kill" } : { _tag: "signals", grace };

/**
 * The words of a Windows command line, split as programs built with the
 * Microsoft C runtime split theirs (`CommandLineToArgvW`): a space or a tab
 * ends a word outside quotes; `"` opens or closes quoting; `2n` backslashes
 * before a quote are `n` backslashes and the quote does its work; `2n+1` are
 * `n` and a literal quote; other backslashes are themselves.
 */
export const windowsCommandWords = (line: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    if (character === "\\") {
      let backslashes = 0;
      while (line[at] === "\\") {
        backslashes++;
        at++;
      }
      if (line[at] === '"') {
        word += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) word += '"';
        else quoted = !quoted;
      } else {
        word += "\\".repeat(backslashes);
        at--;
      }
      inWord = true;
    } else if (character === '"') {
      // Inside quotes, `""` is one literal quote.
      if (quoted && line[at + 1] === '"') {
        word += '"';
        at++;
      } else {
        quoted = !quoted;
      }
      inWord = true;
    } else if ((character === " " || character === "\t") && !quoted) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += character;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
};

/**
 * Whether a command line is the engine serving the data directory `home`:
 * its `serve` command with `--base-dir` set to `home`. On Windows the line is
 * split as the engine itself splits it, and paths compare without case, as
 * Windows compares them. `ps` joins the words with spaces and does not quote,
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
      baseDir.replace(/[\\/]+$/, "").toLowerCase() === home.replace(/[\\/]+$/, "").toLowerCase()
    );
  }
  const words = commandLine.trim().split(/\s+/);
  return words.includes("serve") && ` ${commandLine.trim()} `.includes(` --base-dir ${home} `);
};

/**
 * A program in Windows' own `System32`, by its full path: the search path,
 * which the operator's shell set, is never asked for it.
 */
const system32 = (environment: Readonly<Record<string, string | undefined>>, program: string) =>
  `${environment["SystemRoot"] ?? "C:\\Windows"}\\System32\\${program}`;

/**
 * The arguments that run `script` in Windows PowerShell without a profile or
 * a prompt, stopping at the first error, its output as UTF-8. The script goes
 * as base64 of its UTF-16 text, as `-EncodedCommand` takes it, so nothing in
 * it needs quoting for the command line.
 */
const powerShellArgs = (script: string): ReadonlyArray<string> => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    "utf16le",
  ).toString("base64"),
];

/**
 * `environment` without `PSModulePath`, which PowerShell 7 sets to its own
 * modules: Windows PowerShell 5.1 started from a PowerShell 7 session, as a
 * terminal or a CI runner opens one, inherits it, and then fails to load the
 * modules its first command is in. Without it, 5.1 finds its own.
 */
const withoutModulePath = (environment: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== "PSMODULEPATH",
    ),
  );

/** Windows PowerShell 5.1, which every supported Windows ships. */
const POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";

const POLL = Duration.millis(250);

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

  /** The command line `pid` was started with, if it runs and the system says. */
  const commandLine = (pid: number): Effect.Effect<Option.Option<string>> =>
    spawner
      .string(
        platform === "win32"
          ? boundedCommand(
              system32(environment, POWERSHELL),
              powerShellArgs(
                `$found = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${Math.trunc(pid)}'; if ($found) { [Console]::Out.Write($found.CommandLine) } else { exit 3 }`,
              ),
              {
                stdin: "ignore",
                stderr: "ignore",
                env: withoutModulePath(environment),
                extendEnv: false,
              },
              "15 seconds",
            )
          : boundedCommand("ps", ["-p", String(pid), "-o", "args="], {
              stdin: "ignore",
              stderr: "ignore",
            }),
      )
      .pipe(
        Effect.map((line) => (line.trim() === "" ? Option.none() : Option.some(line.trim()))),
        Effect.orElseSucceed(() => Option.none()),
      );

  const waitUntilGone = (pid: number, within: Duration.Duration) =>
    isAlive(pid).pipe(
      Effect.repeat({ schedule: Schedule.spaced(POLL), until: (alive) => !alive }),
      Effect.timeoutOption(within),
      Effect.map(Option.isSome),
    );

  /**
   * Stops `pid` as `plan` says, and waits until it is gone, for at most
   * `afterKill` past the last step. Returns whether it is gone.
   */
  const stop = Effect.fnUntraced(function* (
    pid: number,
    plan: StopPlan,
    afterKill: Duration.Duration,
  ) {
    switch (plan._tag) {
      case "signals":
        yield* exitCode("kill", ["-TERM", String(pid)]);
        if (yield* waitUntilGone(pid, plan.grace)) return true;
        yield* exitCode("kill", ["-KILL", String(pid)]);
        return yield* waitUntilGone(pid, afterKill);
      case "tree-kill":
        yield* exitCode(system32(environment, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
        return yield* waitUntilGone(pid, afterKill);
    }
  });

  return { isAlive, commandLine, stop };
});
