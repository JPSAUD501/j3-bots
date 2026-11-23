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

/** How many bytes of the server's error output the app keeps, to show and to read a refusal from. */
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

/** The last `TAIL_BYTES` of what was written, cut at a line. */
const tailOf = (text: string): string => {
  if (text.length <= TAIL_BYTES) return text;
  const cut = text.slice(-TAIL_BYTES);
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
};

/** Opens the log for appending, moving a large one aside first. */
const openLog = (file: string): number | null => {
  try {
    const size = NodeFS.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > LOG_ROTATE_BYTES) NodeFS.renameSync(file, `${file}.1`);
    return NodeFS.openSync(file, "a", 0o600);
  } catch {
    return null;
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
    let tail = "";
    const log = openLog(spec.logFile);
    const child = yield* Effect.callback<NodeChildProcess.ChildProcess, LaunchFailed>((resume) => {
      const spawned = NodeChildProcess.spawn(
        spec.node,
        [spec.entry, "serve", "--admin-fd", "3", "--exit-with-stdin"],
        {
          env: spec.env,
          // Windows gives a child a synchronous handle for a plain pipe, whose
          // reads and writes wait on each other; an overlapped one does not.
          // Elsewhere the two are the same.
          stdio: ["pipe", "pipe", "pipe", "overlapped"],
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
    });
    const pipe = child.stdio[3];
    if (child.pid === undefined || !(pipe instanceof NodeNet.Socket)) {
      child.kill("SIGKILL");
      return yield* new LaunchFailed({
        reason: "The server started without its admin channel.",
        retry: true,
      });
    }
    const write = (chunk: Buffer) => {
      if (log !== null) NodeFS.write(log, chunk, () => undefined);
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", (chunk: Buffer) => {
      write(chunk);
      tail = tailOf(tail + chunk.toString("utf8"));
    });
    // The lifeline: held open, never written to, closed by the system with this process.
    child.stdin?.on("error", () => undefined);
    pipe.on("error", () => undefined);
    child.once("exit", (code, signal) => {
      if (log !== null) NodeFS.close(log, () => undefined);
      Deferred.doneUnsafe(exited, Effect.succeed({ code, signal }));
    });
    const pid = child.pid;
    return {
      pid,
      admin: adminChannel.overInheritedPipe(pipe),
      exited: Deferred.await(exited),
      logTail: Effect.sync(() => tail),
      terminate: Effect.sync(() => {
        // Windows has no signal a process can handle: there, the admin
        // channel's `/shutdown` is the only graceful stop.
        if (spec.platform !== "win32") child.kill("SIGTERM");
      }),
      kill: killTree(pid, spec.platform),
    } satisfies RunningServer;
  });
