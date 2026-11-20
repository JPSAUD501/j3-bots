// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Readiness } from "./Readiness.ts";
import type { Trigger } from "./Signals.ts";

/** What one pass of a worker found. */
export type Pass =
  /** The engine refused a command: nothing more is sent until it is ready again. */
  | { readonly _tag: "unavailable" }
  | {
      readonly _tag: "done";
      /**
       * Work was due and left for a later pass: a session not ready or busy,
       * a call that timed out.
       */
      readonly deferred: boolean;
      /** The earliest durable deadline the pass knows of, if any. */
      readonly next: DateTime.Utc | null;
    };

/** How soon a pass that left due work runs again. */
export const RETRY_TICK = Duration.seconds(5);

/** How soon an idle worker looks again with no signal: a nudge lost to a bug costs this much. */
const HEARTBEAT = Duration.minutes(1);

/** How long a worker whose pass failed unexpectedly waits before its next pass. */
export const DEFECT_RETRY = Duration.seconds(30);

/** Collects, while a pass runs, whether it left work and its earliest deadline. */
export const passOutcome = () => {
  let deferred = false;
  let next: DateTime.Utc | null = null;
  return {
    /** Something due could not be done now. */
    defer: () => {
      deferred = true;
    },
    /** Something is due at `at`. */
    until: (at: DateTime.Utc | null) => {
      if (at !== null && (next === null || DateTime.isLessThan(at, next))) next = at;
    },
    done: (): Pass => ({ _tag: "done", deferred, next }),
  };
};

/**
 * A worker's pass, made to run one at a time: a pass the startup sequence or a
 * test runs waits for the worker's own pass to finish, so two passes never
 * plan the same work side by side and a pass that returns has seen every send
 * that the one before it started.
 */
export const onePassAtATime = (pass: Effect.Effect<Pass>): Effect.Effect<Effect.Effect<Pass>> =>
  Effect.map(Semaphore.make(1), (permit) => permit.withPermits(1)(pass));

/**
 * A worker that reconciles durable state (`docs/architecture/server.md`, The
 * workers). Each pass rereads the database and does what is due. A signal
 * only shortens the wait before the next pass: a pass also runs at the
 * earliest durable deadline, a few seconds after one that left due work, and
 * at a slow heartbeat otherwise, so a timeout, a readiness change or a lost
 * signal never leaves work waiting. A pass that fails unexpectedly is logged
 * and the worker waits before the next one, so a defect never spins and never
 * stops the other workers.
 */
export const reconcile = (input: {
  readonly name: string;
  readonly pass: Effect.Effect<Pass>;
  readonly signal: Trigger;
  readonly readiness: Readiness["Service"];
}): Effect.Effect<never> =>
  Effect.gen(function* () {
    yield* input.readiness.released;
    const result = yield* input.pass.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.as(Effect.logError(`${input.name} failed; it runs again later`, cause), null),
      ),
    );
    if (result === null) return yield* Effect.sleep(DEFECT_RETRY);
    if (result._tag === "unavailable") return yield* input.readiness.changeOrRetry;
    const now = yield* DateTime.now;
    const due =
      result.next === null
        ? null
        : DateTime.isGreaterThan(result.next, now)
          ? DateTime.distance(now, result.next)
          : // Due already and not done by this pass: left for a later one.
            RETRY_TICK;
    const base = result.deferred ? RETRY_TICK : HEARTBEAT;
    const wait = due === null ? base : Duration.min(base, due);
    yield* input.signal.next.pipe(Effect.timeoutOption(wait));
  }).pipe(Effect.forever, Effect.withSpan(input.name));
