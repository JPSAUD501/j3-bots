// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { AdminChannel } from "./adminChannel.ts";
import { STOP_DEADLINE, type RunningServer, type ServerExit } from "./supervisor.ts";

// A server an earlier run of the app left running, found as the app starts.
// The lifeline makes one rare: a server stops when the app that started it
// ends. It can still be there while it finishes stopping, or when the system
// kept a pipe open. Two servers cannot share the home (the second is refused),
// so the app takes over one of its own version, and stops any other.
//
// On Unix the app finds it on `<home>/admin.sock` and asks it its pid. On
// Windows the server's only admin channel is the pipe its parent held, which
// went with that parent, so the app records the pid of each server it starts
// and, finding that process still running the same Node, ends it.

/** Whether process `pid` still runs. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return error instanceof Error && Reflect.get(error, "code") === "EPERM";
  }
};

/** Succeeds once `pid` no longer runs, checking every half second. */
const gone = (pid: number) =>
  Effect.sync(() => isRunning(pid)).pipe(
    Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("500 millis") }),
    Effect.asVoid,
  );

const signal = (pid: number, name: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  });

/** A server found on the admin socket, as the supervisor runs it: it cannot see its exit code or output. */
const adopted = (pid: number, admin: AdminChannel): RunningServer => ({
  pid,
  admin,
  exited: gone(pid).pipe(Effect.as<ServerExit>({ code: null, signal: null })),
  logTail: Effect.succeed(""),
  terminate: signal(pid, "SIGTERM"),
  kill: signal(pid, "SIGKILL"),
});

/**
 * What to do with the server found on the admin socket (Unix): take it over
 * when it is this version, which the app would start anyway; stop it
 * otherwise, gracefully, then for good after `STOP_DEADLINE`.
 */
export const takeOverOnSocket = Effect.fn("Orphans.takeOverOnSocket")(function* (
  admin: AdminChannel,
  version: string,
) {
  const status = yield* admin.status(Duration.seconds(5)).pipe(Effect.option);
  if (Option.isNone(status)) return Option.none<RunningServer>();
  const { pid } = status.value;
  if (status.value.version === version) {
    yield* Effect.logInfo("Taking over the server an earlier run of the app left running", { pid });
    return Option.some(adopted(pid, admin));
  }
  yield* Effect.logInfo("Stopping a server of another version an earlier run left running", {
    pid,
    version: status.value.version,
  });
  yield* admin.shutdown.pipe(Effect.catch(() => signal(pid, "SIGTERM")));
  const stopped = yield* gone(pid).pipe(Effect.timeoutOption(STOP_DEADLINE));
  if (Option.isNone(stopped)) yield* signal(pid, "SIGKILL");
  return Option.none<RunningServer>();
});

// ---------------------------------------------------------------------------
// Windows

/** The server the app last started, as it recorded it. */
const Recorded = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  node: Schema.String,
});
const decodeRecorded = Schema.decodeUnknownOption(Schema.fromJsonString(Recorded));
const encodeRecorded = Schema.encodeSync(Schema.fromJsonString(Recorded));

/** Records the server just started, for the next run to find if it is left behind. */
export const record = Effect.fn("Orphans.record")(function* (
  file: string,
  pid: number,
  node: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(file, encodeRecorded({ pid, node }), { mode: 0o600 })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Recording the local server's process failed", error),
      ),
    );
});

/**
 * The executable process `pid` runs, as PowerShell reads it, or none: a
 * recorded pid may since have been given to another program, which must not
 * be ended.
 */
const windowsExecutable = Effect.fn("Orphans.windowsExecutable")(
  function* (pid: number) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).Path`],
        { stdin: "ignore", stderr: "ignore", windowsHide: true },
      ),
    );
    return (yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)).trim();
  },
  Effect.scoped,
  Effect.timeoutOption(Duration.seconds(10)),
  Effect.map(Option.filter((path) => path.length > 0)),
  Effect.orElseSucceed(() => Option.none<string>()),
);

/**
 * Ends the server recorded in `file` (Windows) if it still runs the Node it
 * was started with: by its tree (`kill`), since no graceful stop reaches it.
 */
export const stopRecorded = Effect.fn("Orphans.stopRecorded")(function* (
  file: string,
  kill: (pid: number) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(text)) return;
  const recorded = decodeRecorded(text.value);
  yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
  if (Option.isNone(recorded) || !isRunning(recorded.value.pid)) return;
  const executable = yield* windowsExecutable(recorded.value.pid);
  const same =
    Option.isSome(executable) &&
    path.resolve(executable.value).toLowerCase() ===
      path.resolve(recorded.value.node).toLowerCase();
  if (!same) return;
  yield* Effect.logInfo("Ending the server an earlier run of the app left running", {
    pid: recorded.value.pid,
  });
  yield* kill(recorded.value.pid);
  yield* gone(recorded.value.pid).pipe(Effect.timeoutOption(Duration.seconds(10)));
});
