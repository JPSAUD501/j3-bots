// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- An MCP server's standard streams are node:child_process's pipes, which the SDK's transport reads as Node streams.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";
import { inJob, jobLauncher } from "@j3-bots/processes";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { CommandFailed } from "../errors.ts";

/**
 * A command connector's process, with everything it starts
 * (`docs/architecture/server.md`, "Connectors started by command").
 *
 * It starts with no shell. Its standard input and output carry MCP; its
 * standard error goes nowhere, since a server may print what it was given
 * there, and nothing of it is read, kept or logged.
 *
 * What it starts is stopped with it. On Linux and macOS it leads a process
 * group of its own, which the stop signals as a whole. On Windows, which has
 * no process groups, it runs in a job object that ends every process in it
 * once its launcher ends (`inJob`, in `@j3-bots/processes`), and the stop ends
 * the launcher. The stop first closes its input, as the MCP specification
 * asks a client to, and gives it a moment to end by itself.
 */

/** How long a process gets to end once its input is closed. */
const INPUT_CLOSED_GRACE = Duration.seconds(2);
/** How long what is left of it gets after SIGTERM, before SIGKILL. */
const TERM_GRACE = Duration.seconds(3);
/** How long the stop waits for what is left after the last signal. */
const KILL_GRACE = Duration.seconds(3);
const POLL = Duration.millis(50);

export interface RunningProcess {
  readonly pid: number;
  /** What the client writes to the process. */
  readonly input: NodeStream.Writable;
  /** What the process writes to the client. */
  readonly output: NodeStream.Readable;
  /** Done once the process has ended, by itself or by the stop. */
  readonly ended: Effect.Effect<void>;
}

export interface ProcessInput {
  readonly platform: NodeJS.Platform;
  /** The program's full path. */
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Whether the process has ended. */
const hasEnded = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

/** Whether any process of the group `pid` leads is left, by a null signal to the group. */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
};

/** Whether `done` holds within `within`, asked every {@link POLL}. */
const within = (done: () => boolean, duration: Duration.Duration) =>
  Effect.sync(done).pipe(
    Effect.repeat({ schedule: Schedule.spaced(POLL), until: (holds) => holds }),
    Effect.timeoutOption(duration),
    Effect.map(Option.isSome),
  );

/** Ends the process and what it started, its input closed first. */
const stop = Effect.fn("CommandProcess.stop")(function* (
  child: NodeChildProcess.ChildProcess,
  platform: NodeJS.Platform,
) {
  child.stdin?.end();
  yield* within(() => hasEnded(child), INPUT_CLOSED_GRACE);
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    // Ending the launcher closes the job's only handle, and Windows ends the rest.
    if (!hasEnded(child)) child.kill();
    yield* within(() => hasEnded(child), KILL_GRACE);
    return;
  }
  // A process it started may outlive it, still in its group.
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  if (yield* within(() => !groupAlive(pid), TERM_GRACE)) return;
  signalGroup(pid, "SIGKILL");
  yield* within(() => !groupAlive(pid), KILL_GRACE);
});

/**
 * Starts the process; it is stopped, with everything it started, when the
 * scope closes. Fails with `CommandFailed("exited")` when it cannot start.
 */
export const startProcess = (
  input: ProcessInput,
): Effect.Effect<RunningProcess, CommandFailed, Scope.Scope> =>
  (input.platform === "win32"
    ? Effect.tryPromise({
        try: () => jobLauncher(input.environment),
        catch: () => new CommandFailed({ reason: "exited" }),
      }).pipe(Effect.map((launcher) => inJob(launcher, input.executable, input.args, "relay")))
    : Effect.succeed({ command: input.executable, args: input.args })
  ).pipe(Effect.flatMap((launched) => spawned(input, launched)));

/** The process `launched` starts, stopped when the scope closes. */
const spawned = (
  input: ProcessInput,
  launched: { readonly command: string; readonly args: ReadonlyArray<string> },
): Effect.Effect<RunningProcess, CommandFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<NodeChildProcess.ChildProcess, CommandFailed>((resume) => {
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(launched.command, [...launched.args], {
          cwd: input.cwd,
          // Node adds its own NODE_V8_COVERAGE to a child's environment unless the environment
          // names it: so it is named, and left out unless the command was given it.
          env: { NODE_V8_COVERAGE: undefined, ...input.environment },
          stdio: ["pipe", "pipe", "ignore"],
          detached: input.platform !== "win32",
          windowsHide: true,
        });
      } catch {
        resume(Effect.fail(new CommandFailed({ reason: "exited" })));
        return;
      }
      // A write to a process that ended fails on the stream; the transport hears of it by its
      // callback. A failed signal is the stop's to see, by the process still running.
      child.stdin?.on("error", () => undefined);
      child.stdout?.on("error", () => undefined);
      child.on("error", () => undefined);
      const started = () => resume(Effect.succeed(child));
      const failed = () => resume(Effect.fail(new CommandFailed({ reason: "exited" })));
      child.once("spawn", started);
      child.once("error", failed);
      return Effect.sync(() => {
        child.off("spawn", started);
        child.off("error", failed);
      });
    }),
    (child) => stop(child, input.platform),
  ).pipe(
    Effect.flatMap((child) => {
      const { pid, stdin, stdout } = child;
      if (pid === undefined || stdin === null || stdout === null) {
        return Effect.fail(new CommandFailed({ reason: "exited" }));
      }
      const ended = Effect.callback<void>((resume) => {
        if (hasEnded(child)) {
          resume(Effect.void);
          return;
        }
        const onExit = () => resume(Effect.void);
        child.once("exit", onExit);
        return Effect.sync(() => child.off("exit", onExit));
      });
      return Effect.succeed({ pid, input: stdin, output: stdout, ended } satisfies RunningProcess);
    }),
  );
