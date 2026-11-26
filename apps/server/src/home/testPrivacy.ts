// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { powerShellLiteral } from "@j3-bots/processes";
import { runPowerShell } from "../system/PowerShell.ts";
import { judgeAcl, readFolderAcl } from "./windowsAcl.ts";

// For tests that set a folder's privacy as an operator would, on the system
// they run on: by its mode bits, or on Windows by its access control list.

/** The machine's Users group, which every account on it is in. */
const USERS = "S-1-5-32-545";

/** Runs `script` in `cmd.exe`, as the operator would, and fails unless it succeeds. */
export const runInCommandPrompt = Effect.fn("runInCommandPrompt")(function* (script: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(script, { shell: true, stdin: "ignore" }),
      );
      const [, exitCode] = yield* Effect.all(
        [handle.all.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return exitCode;
    }),
  );
  assert.strictEqual(Number(exitCode), 0, script);
});

/** Runs `command` in Windows PowerShell, as the operator would, and fails unless it succeeds. */
export const runInPowerShell = (command: string) =>
  runPowerShell(`${command}; exit $LASTEXITCODE`, {});

/** Lets every other account on the machine open and read `folder`. */
export const openToOthers = Effect.fn("openToOthers")(function* (folder: string) {
  if (process.platform === "win32") {
    return yield* runInPowerShell(
      `icacls ${powerShellLiteral(folder)} /grant ${powerShellLiteral(`*${USERS}:(OI)(CI)RX`)}`,
    );
  }
  yield* (yield* FileSystem.FileSystem).chmod(folder, 0o750);
});

/** Whether only this user (and, on Windows, SYSTEM and the Administrators) may open `folder`. */
export const isPrivate = Effect.fn("isPrivate")(function* (folder: string) {
  if (process.platform === "win32") return judgeAcl(yield* readFolderAcl(folder)) === "private";
  return ((yield* (yield* FileSystem.FileSystem).stat(folder)).mode & 0o777) === 0o700;
});

/** What `HomeNotPrivate`'s fix names to repair a home on this system. */
export const REPAIR = process.platform === "win32" ? "icacls" : "chmod 700";
