// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is a child with an inherited duplex pipe on fd 3 and a stdin it never reads, which only Node's own spawn gives as sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as adminChannel from "./adminChannel.ts";
import { LaunchFailed, type RunningServer, type ServerExit } from "./supervisor.ts";

// The server process the app starts, as a child of its main process:
//
//   <runtime>/node/bin/node <runtime>/server/bin.mjs serve --admin-fd 3 --exit-with-stdin
//
// fd 3 is a duplex pipe only this process holds, the server's admin channel
// (on Windows the only one). stdin is a pipe the app never writes to and
// never closes: when the app's process ends, however it ends, the system
// closes it, and the server, seeing the end of its input, stops as on
// SIGTERM. So a server never outlives the app that started it.
//
// Its output goes straight to its log file, which it inherits as stdout and
// stderr: never through the app, whose death would leave the server writing
// to a pipe no one reads, and failing as it stops, before it stops its
// engine. What the page and the tray show of it is read back from the file.

/** How many bytes of the server's last output the app keeps, to show and to read a refusal from. */
const TAIL_BYTES = 8192;
/** A log file larger than this is moved aside, once, before a start appends to it. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export interface LaunchSpec {
  readonly node: string;
  readonly entry: string;
  /** The server's whole environment: nothing else is inherited. */
  readonly env: Record<string, string>;
  /** Where its output is appended (`server.log`, moved to `server.log.1` when large). */
  readonly logFile: string;
  readonly platform: NodeJS.Platform;
}

/** The log, opened for this start to append to, and where this start's output begins in it. */
interface OpenLog {
  readonly fd: number;
  readonly start: number;
}

/** Opens the log for appending, moving a large one aside first. */
const openLog = (file: string): OpenLog | null => {
  try {
    const size = NodeFS.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > LOG_ROTATE_BYTES) NodeFS.renameSync(file, `${file}.1`);
    const fd = NodeFS.openSync(file, "a", 0o600);
    return { fd, start: NodeFS.fstatSync(fd).size };
  } catch {
    return null;
  }
};

/** The last `TAIL_BYTES` this start wrote to `file` from `start` on, cut at a line. */
const tailOf = (file: string, start: number): string => {
  try {
    const fd = NodeFS.openSync(file, "r");
    try {
      const size = NodeFS.fstatSync(fd).size;
      const from = Math.max(start, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.max(0, size - from));
      const read = NodeFS.readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.subarray(0, read).toString("utf8");
      if (from === start) return text;
      const newline = text.indexOf("\n");
      return newline === -1 ? text : text.slice(newline + 1);
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return "";
  }
};

/**
 * Ends `pid` and every process it started, at once: the last resort on
 * Windows, which has no signal a process can handle, where `taskkill /T`
 * walks the tree.
 */
export const killTree = (pid: number, platform: NodeJS.Platform) =>
  Effect.callback<void>((resume) => {
    if (platform !== "win32") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      resume(Effect.void);
      return;
    }
    const taskkill = NodeChildProcess.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", () => resume(Effect.void));
    taskkill.once("exit", () => resume(Effect.void));
  });

/** Starts the server; resolves once the system has started it, or fails. */
export const launch = (spec: LaunchSpec): Effect.Effect<RunningServer, LaunchFailed> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ServerExit>();
    const log = openLog(spec.logFile);
    const output = log === null ? "ignore" : log.fd;
    const child = yield* Effect.callback<NodeChildProcess.ChildProcess, LaunchFailed>((resume) => {
      const spawned = NodeChildProcess.spawn(
        spec.node,
        [spec.entry, "serve", "--admin-fd", "3", "--exit-with-stdin"],
        {
          env: spec.env,
          // Windows gives a child a synchronous handle for a plain pipe, whose
          // reads and writes wait on each other; an overlapped one does not.
          // Elsewhere the two are the same.
          stdio: ["pipe", output, output, "overlapped"],
          windowsHide: true,
        },
      );
      spawned.once("spawn", () => resume(Effect.succeed(spawned)));
      spawned.once("error", (error) =>
        resume(
          Effect.fail(
            new LaunchFailed({
              reason: `The server could not be started: ${error.message}`,
              retry: true,
            }),
          ),
        ),
      );
    }).pipe(
      // The child holds its own copy of the log; the app's is no longer needed.
      Effect.ensuring(
        Effect.sync(() => {
          if (log !== null) NodeFS.closeSync(log.fd);
        }),
      ),
    );
    const pipe = child.stdio[3];
    if (child.pid === undefined || !(pipe instanceof NodeNet.Socket)) {
      child.kill("SIGKILL");
      return yield* new LaunchFailed({
        reason: "The server started without its admin channel.",
        retry: true,
      });
    }
    // The lifeline: held open, never written to, closed by the system with this process.
    child.stdin?.on("error", () => undefined);
    pipe.on("error", () => undefined);
    child.once("exit", (code, signal) =>
      Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })),
    );
    const pid = child.pid;
    return {
      pid,
      admin: adminChannel.overInheritedPipe(pipe),
      exited: Deferred.await(exited),
      logTail: Effect.sync(() => (log === null ? "" : tailOf(spec.logFile, log.start))),
      terminate: Effect.sync(() => {
        // Windows has no signal a process can handle: there, the admin
        // channel's `/shutdown` is the only graceful stop.
        if (spec.platform !== "win32") child.kill("SIGTERM");
      }),
      kill: killTree(pid, spec.platform),
    } satisfies RunningServer;
  });
