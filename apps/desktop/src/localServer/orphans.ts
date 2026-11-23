// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { AdminChannel } from "./adminChannel.ts";
import * as Probe from "./probe.ts";
import { STOP_DEADLINE, type RunningServer, type ServerExit } from "./supervisor.ts";

// A server an earlier run of the app left running, found as the app starts.
// The lifeline makes one rare: a server stops when the app that started it
// ends. It can still be there while it finishes stopping, or when the system
// kept a pipe open. Two servers cannot share the home (the second is refused),
// so the app takes over one of its own version, and stops any other.
//
// On Unix the app finds it on `<home>/admin.sock` and asks it its pid. A pid
// is given again once its process ends, so the app also notes when that
// process started, and signals it only while the process with that pid is
// the one that started then. On Windows the server's only admin channel is
// the pipe its parent held, which went with that parent, so the app records
// the pid of each server it starts and, finding that process still running
// the same Node, ends it.

/** How long a `ps` that reads a process's start may take (macOS). */
const PS_DEADLINE = Duration.seconds(5);

/** What the app needs of the system's processes on Unix. */
export interface Processes {
  /**
   * When process `pid` started, as the system records it: the same for as
   * long as that process runs, another for a later one given its pid. None
   * once no process has the pid, or where it cannot be read.
   */
  readonly startOf: (pid: number) => Effect.Effect<Option.Option<string>>;
  readonly signal: (pid: number, name: NodeJS.Signals) => Effect.Effect<void>;
}

/**
 * The start time in `/proc/<pid>/stat` (Linux): its 22nd field, in clock
 * ticks since boot. The second field, the command's name in parentheses, may
 * itself hold spaces and parentheses, so fields are counted from its last `)`.
 */
export const linuxStartTime = (stat: string): Option.Option<string> => {
  const close = stat.lastIndexOf(")");
  if (close === -1) return Option.none();
  // After the name: field 3 (the state) is the first, so field 22 is the 20th.
  const field = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return field !== undefined && /^\d+$/.test(field) ? Option.some(field) : Option.none();
};

const signalNow = (pid: number, name: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  });

/** The system's processes on `platform` (Linux or macOS). */
export const systemProcesses = Effect.fn("Orphans.systemProcesses")(function* (
  platform: NodeJS.Platform,
) {
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  const fs = yield* FileSystem.FileSystem;
  const startOf = (pid: number): Effect.Effect<Option.Option<string>> => {
    switch (platform) {
      case "linux":
        return fs.readFileString(`/proc/${pid}/stat`).pipe(
          Effect.map(linuxStartTime),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
      case "darwin":
        return Probe.outputOf("ps", ["-o", "lstart=", "-p", String(pid)], {
          deadline: PS_DEADLINE,
        }).pipe(
          Effect.map((output) =>
            output.pipe(
              Option.map((line) => line.trim()),
              Option.filter((line) => line.length > 0),
            ),
          ),
          Effect.provideContext(context),
        );
      default:
        return Effect.succeedNone;
    }
  };
  return { startOf, signal: signalNow } satisfies Processes;
});

/** Process `pid` as it was when it started at `started`, and what may be done to it. */
const knownProcess = (processes: Processes, pid: number, started: string) => {
  const still = processes
    .startOf(pid)
    .pipe(Effect.map((now) => Option.isSome(now) && now.value === started));
  return {
    /** Succeeds once that process no longer runs, checking every half second. */
    gone: still.pipe(
      Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("500 millis") }),
      Effect.asVoid,
    ),
    /** Sends `name` to it, if it still runs: never to a later process given its pid. */
    signal: Effect.fn("Orphans.signalKnown")(function* (name: NodeJS.Signals) {
      if (yield* still) yield* processes.signal(pid, name);
    }),
  };
};

/** A server found on the admin socket, as the supervisor runs it: it cannot see its exit code or output. */
const adopted = (
  pid: number,
  admin: AdminChannel,
  known: ReturnType<typeof knownProcess>,
): RunningServer => ({
  pid,
  admin,
  exited: known.gone.pipe(Effect.as<ServerExit>({ code: null, signal: null })),
  logTail: Effect.succeed(""),
  terminate: known.signal("SIGTERM").pipe(Effect.as(true)),
  kill: known.signal("SIGKILL"),
});

/**
 * What to do with the server found on the admin socket (Unix): take it over
 * when it is `version`, the release the app would start as it is anyway;
 * stop it otherwise, or with no version given, gracefully, then for good
 * after `STOP_DEADLINE`. A server whose
 * process cannot be told apart from a later one given its pid is left alone:
 * the start that follows is refused while it runs, and says so.
 */
export const takeOverOnSocket = Effect.fn("Orphans.takeOverOnSocket")(function* (
  admin: AdminChannel,
  version: Option.Option<string>,
  processes: Processes,
) {
  const status = yield* admin.status(Duration.seconds(5)).pipe(Effect.option);
  if (Option.isNone(status)) return Option.none<RunningServer>();
  const { pid } = status.value;
  const started = yield* processes.startOf(pid);
  if (Option.isNone(started)) {
    yield* Effect.logWarning(
      "The server an earlier run left running cannot be told apart from another process; it is left alone",
      { pid },
    );
    return Option.none<RunningServer>();
  }
  const known = knownProcess(processes, pid, started.value);
  if (Option.contains(version, status.value.version)) {
    yield* Effect.logInfo("Taking over the server an earlier run of the app left running", { pid });
    return Option.some(adopted(pid, admin, known));
  }
  yield* Effect.logInfo("Stopping a server an earlier run left running, which it would not start", {
    pid,
    version: status.value.version,
  });
  yield* admin.shutdown.pipe(Effect.catch(() => known.signal("SIGTERM")));
  const stopped = yield* known.gone.pipe(Effect.timeoutOption(STOP_DEADLINE));
  if (Option.isNone(stopped)) yield* known.signal("SIGKILL");
  return Option.none<RunningServer>();
});

// ---------------------------------------------------------------------------
// Windows

/** Whether process `pid` still runs (Windows, where its executable tells it apart). */
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
const exitedPid = (pid: number) =>
  Effect.sync(() => isRunning(pid)).pipe(
    Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("500 millis") }),
    Effect.asVoid,
  );

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
const windowsExecutable = (pid: number) =>
  Probe.outputOf(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).Path`],
    { deadline: Duration.seconds(10) },
  ).pipe(
    Effect.map((output) =>
      output.pipe(
        Option.map((path) => path.trim()),
        Option.filter((path) => path.length > 0),
      ),
    ),
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
  yield* exitedPid(recorded.value.pid).pipe(Effect.timeoutOption(Duration.seconds(10)));
});
