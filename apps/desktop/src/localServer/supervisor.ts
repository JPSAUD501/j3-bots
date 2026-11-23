// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalServerState } from "@j3-bots/desktop-bridge";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AdminChannel } from "./adminChannel.ts";

// Keeps the server on this computer running while the app wants it: starts
// it, sees it answer, starts it again with a growing pause when it stops on
// its own, and stops it gracefully when asked. A start the server refused is
// never repeated by itself: its message, which says how to repair it, waits
// for the operator to try again.

/** How a server process ended: its exit code, or the signal that ended it. */
export interface ServerExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** A server the supervisor runs: one it started, or one left running it took over. */
export interface RunningServer {
  readonly pid: number;
  readonly admin: AdminChannel;
  /** Succeeds once the process has exited. */
  readonly exited: Effect.Effect<ServerExit>;
  /** The last lines this start of it wrote to its log. */
  readonly logTail: Effect.Effect<string>;
  /**
   * Asks the system to end it gracefully, where there is a way to (SIGTERM on
   * Unix): whether it could ask. Windows has none.
   */
  readonly terminate: Effect.Effect<boolean>;
  /** Ends it, and what it started, at once. */
  readonly kill: Effect.Effect<void>;
}

/**
 * The server could not be started, for a reason the operator must repair
 * (`refused`: a home others can open, a runtime missing from the app) or
 * one that may pass (`retry`: a copy that ran out of disk, say).
 */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  reason: Schema.String,
  fix: Schema.optionalKey(Schema.String),
  retry: Schema.Boolean,
}) {}

/** The exit code of a start the server refused (`START_REFUSED` in `apps/server/src/cli/serve.ts`). */
export const START_REFUSED = 78;

/** How long a server may take to answer, from its start, before it counts as hung. */
const READY_DEADLINE = Duration.minutes(5);
/** How long a server must have answered for its next stop to count as its first. */
export const HEALTHY_AFTER = Duration.seconds(60);
/** How long a graceful stop may take before the server is killed. */
export const STOP_DEADLINE = Duration.seconds(30);
const LONGEST_PAUSE = Duration.seconds(30);

/**
 * The pause before start `attempt` after the server stopped on its own:
 * one second, doubled each time, up to thirty.
 */
export const restartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 ** Math.max(0, attempt - 1)), LONGEST_PAUSE);

/** The last thing the server wrote before it ended: its refusal, for a refused start. */
const lastMessage = (logTail: string): string | undefined => {
  const lines = logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // The server's own logs are JSON lines; a refusal is the plain text after them.
  const plain = lines.filter((line) => !line.startsWith("{"));
  return (plain.length > 0 ? plain.slice(-3).join(" ") : lines.at(-1))?.slice(0, 4096);
};

/** The server is not ready to be used, and why, as `LocalServerState` says it. */
export class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {
  state: Schema.Literals(["stopped", "failed"]),
}) {}

/** Where the supervisor stands, with the server itself while it answers. */
type Phase =
  | { readonly _tag: "stopped"; readonly reason?: string }
  | { readonly _tag: "starting"; readonly attempt: number }
  | { readonly _tag: "ready"; readonly attempt: number; readonly server: RunningServer }
  | {
      readonly _tag: "restarting";
      readonly attempt: number;
      readonly retryInSeconds: number;
      readonly reason?: string;
      readonly logTail?: string;
    }
  | {
      readonly _tag: "failed";
      readonly reason: string;
      readonly fix?: string;
      readonly logTail?: string;
    };

/** What the page and the tray are told of `phase`. */
const publicState = (phase: Phase): LocalServerState => {
  switch (phase._tag) {
    case "stopped":
      return { state: "stopped", ...(phase.reason === undefined ? {} : { reason: phase.reason }) };
    case "starting":
      return { state: "starting", attempt: phase.attempt };
    case "ready":
      return { state: "ready", attempt: phase.attempt };
    case "restarting":
      return {
        state: "restarting",
        attempt: phase.attempt,
        retryInSeconds: phase.retryInSeconds,
        ...(phase.reason === undefined ? {} : { reason: phase.reason }),
        ...(phase.logTail === undefined ? {} : { logTail: phase.logTail }),
      };
    case "failed":
      return {
        state: "failed",
        reason: phase.reason,
        ...(phase.fix === undefined ? {} : { fix: phase.fix }),
        ...(phase.logTail === undefined ? {} : { logTail: phase.logTail }),
      };
  }
};

export interface SupervisorOptions {
  /** Starts a server process. */
  readonly launch: Effect.Effect<RunningServer, LaunchFailed>;
  /** A server already running on this home, taken over at the first start, if there is one. */
  readonly adopt: Effect.Effect<Option.Option<RunningServer>>;
}

export interface Supervisor {
  readonly state: Effect.Effect<LocalServerState>;
  /** The state now, then each change. */
  readonly changes: Stream.Stream<LocalServerState>;
  /** Starts the server, unless it runs or is being started. */
  readonly start: Effect.Effect<void>;
  /** Starts it now: after a refusal, or without waiting out a pause. */
  readonly retry: Effect.Effect<void>;
  /**
   * Stops it gracefully (`/shutdown`, then SIGTERM where there is one), and
   * kills it if it has not stopped after `STOP_DEADLINE`. Ends once it has.
   */
  readonly stop: Effect.Effect<void>;
  /** The server once it answers; fails if it stops or fails first. */
  readonly ready: Effect.Effect<RunningServer, NotReady>;
  /**
   * Checks that a server that answered still does, as after the system slept.
   * One that does not is killed, and started again as after any stop.
   */
  readonly ping: Effect.Effect<void>;
}

/**
 * Stops `server`: asks it on its admin channel, or, where it cannot be asked
 * there, by the system's graceful signal, and kills it if it has not stopped
 * `STOP_DEADLINE` after the stop began, however long the asking took. Where
 * it can be asked neither way (Windows, its pipe already closed), it is
 * killed at once.
 */
const stopServer = Effect.fn("Supervisor.stopServer")(function* (server: RunningServer) {
  const stopped = yield* Effect.gen(function* () {
    const asked = yield* server.admin.shutdown.pipe(
      Effect.as(true),
      Effect.catch(() => server.terminate),
    );
    if (!asked) return false;
    yield* server.exited;
    return true;
  }).pipe(Effect.timeoutOption(STOP_DEADLINE), Effect.map(Option.getOrElse(() => false)));
  if (!stopped) {
    yield* Effect.logWarning("The local server did not stop when asked, so it was killed");
    yield* server.kill;
    yield* server.exited.pipe(Effect.timeoutOption(Duration.seconds(5)));
  }
});

export const make = Effect.fn("Supervisor.make")(function* (options: SupervisorOptions) {
  const scope = yield* Effect.scope;
  const phase = yield* SubscriptionRef.make<Phase>({ _tag: "stopped" });
  /** The supervising fiber while there is one, and the server it runs. */
  const running = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  const current = yield* Ref.make<Option.Option<RunningServer>>(Option.none());
  /** Completed to cut a pause short. */
  const wake = yield* Ref.make(yield* Deferred.make<void>());
  const oneAtATime = yield* Semaphore.make(1);
  let adopted = false;

  const set = (next: Phase) => SubscriptionRef.set(phase, next);

  /** Waits `delay`, or less if the operator asks to try again. */
  const pause = Effect.fn("Supervisor.pause")(function* (delay: Duration.Duration) {
    const signal = yield* Deferred.make<void>();
    yield* Ref.set(wake, signal);
    yield* Deferred.await(signal).pipe(
      Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
    );
  });

  /** Runs `server` until it exits; whether it answered, and for how long. */
  const watch = Effect.fn("Supervisor.watch")(function* (server: RunningServer, attempt: number) {
    const answered = yield* Effect.raceFirst(
      server.admin.status(READY_DEADLINE).pipe(
        Effect.map((status) => (status.pid === server.pid ? "ready" : "not-ours")),
        Effect.orElseSucceed(() => "no-answer" as const),
      ),
      server.exited.pipe(Effect.as("exited" as const)),
    );
    if (answered !== "ready") {
      if (answered === "not-ours") {
        yield* Effect.logError("The local server's admin channel answered for another process");
      }
      if (answered !== "exited") yield* server.kill;
      return { exit: yield* server.exited, healthy: false };
    }
    const since = yield* Clock.currentTimeMillis;
    yield* set({ _tag: "ready", attempt, server });
    const exit = yield* server.exited;
    const ended = yield* Clock.currentTimeMillis;
    return { exit, healthy: ended - since >= Duration.toMillis(HEALTHY_AFTER) };
  });

  /** Keeps the server running, until it is stopped or refuses to start. */
  const supervise = Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      attempt += 1;
      yield* set({ _tag: "starting", attempt });
      const takeOver = adopted ? Option.none<RunningServer>() : yield* options.adopt;
      adopted = true;
      const launched = Option.isSome(takeOver)
        ? { _tag: "launched" as const, server: takeOver.value }
        : yield* Effect.uninterruptible(
            options.launch.pipe(
              Effect.tap((server) => Ref.set(current, Option.some(server))),
              Effect.map((server) => ({ _tag: "launched" as const, server })),
              Effect.catch((failure) => Effect.succeed({ _tag: "not-launched" as const, failure })),
            ),
          );
      if (launched._tag === "not-launched") {
        const { failure } = launched;
        if (!failure.retry) {
          return yield* set({
            _tag: "failed",
            reason: failure.reason,
            ...(failure.fix === undefined ? {} : { fix: failure.fix }),
          });
        }
        const delay = restartDelay(attempt);
        yield* set({
          _tag: "restarting",
          attempt,
          retryInSeconds: Math.ceil(Duration.toSeconds(delay)),
          reason: failure.reason,
        });
        yield* pause(delay);
        continue;
      }
      const { server } = launched;
      yield* Ref.set(current, Option.some(server));
      const { exit, healthy } = yield* watch(server, attempt);
      yield* Ref.set(current, Option.none());
      const logTail = yield* server.logTail;
      if (exit.code === START_REFUSED) {
        return yield* set({
          _tag: "failed",
          reason: lastMessage(logTail) ?? "The server refused to start.",
          logTail,
        });
      }
      // A server that ran a minute counts as healthy: its stop is the first again.
      if (healthy) attempt = 0;
      const stops = Math.max(attempt, 1);
      const delay = restartDelay(stops);
      yield* Effect.logWarning("The local server stopped; starting it again", exit);
      yield* set({
        _tag: "restarting",
        attempt: stops,
        retryInSeconds: Math.ceil(Duration.toSeconds(delay)),
        reason:
          exit.signal === null
            ? `The server stopped with exit code ${exit.code ?? "unknown"}.`
            : `The server was stopped by ${exit.signal}.`,
        logTail,
      });
      yield* pause(delay);
    }
  });

  const start = oneAtATime.withPermits(1)(
    Effect.gen(function* () {
      const fiber = yield* Ref.get(running);
      if (Option.isSome(fiber) && fiber.value.pollUnsafe() === undefined) return;
      // Set before the fork, so a sign-in that waits on `ready` right after
      // `start` sees a start under way rather than the server stopped.
      yield* set({ _tag: "starting", attempt: 1 });
      const forked = yield* supervise.pipe(Effect.forkIn(scope));
      yield* Ref.set(running, Option.some(forked));
    }),
  );

  const stop = oneAtATime.withPermits(1)(
    Effect.gen(function* () {
      const fiber = yield* Ref.get(running);
      yield* Ref.set(running, Option.none());
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      const server = yield* Ref.getAndSet(current, Option.none());
      if (Option.isSome(server)) yield* stopServer(server.value);
      yield* set({ _tag: "stopped" });
    }),
  );

  const retry = Effect.gen(function* () {
    const now = yield* SubscriptionRef.get(phase);
    if (now._tag === "restarting") return yield* Deferred.succeed(yield* Ref.get(wake), undefined);
    if (now._tag === "failed" || now._tag === "stopped") yield* start;
  }).pipe(Effect.asVoid);

  const ready = SubscriptionRef.changes(phase).pipe(
    Stream.filter((now) => now._tag === "ready" || now._tag === "failed" || now._tag === "stopped"),
    Stream.runHead,
    Effect.flatMap((now) =>
      Option.isSome(now) && now.value._tag === "ready"
        ? Effect.succeed(now.value.server)
        : Effect.fail(
            new NotReady({
              state: Option.isSome(now) && now.value._tag === "failed" ? "failed" : "stopped",
            }),
          ),
    ),
  );

  const ping = Effect.gen(function* () {
    const now = yield* SubscriptionRef.get(phase);
    if (now._tag !== "ready") return;
    const answered = yield* now.server.admin.status(Duration.seconds(10)).pipe(Effect.option);
    if (Option.isNone(answered)) {
      yield* Effect.logWarning(
        "The local server did not answer after the system woke; restarting it",
      );
      yield* now.server.kill;
    }
  });

  yield* Scope.addFinalizer(scope, stop);

  return {
    state: SubscriptionRef.get(phase).pipe(Effect.map(publicState)),
    changes: SubscriptionRef.changes(phase).pipe(Stream.map(publicState)),
    start,
    retry,
    stop,
    ready,
    ping,
  } satisfies Supervisor;
});
