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
    done: (): Extract<Pass, { readonly _tag: "done" }> => ({ _tag: "done", deferred, next }),
  };
};

/**
 * A worker's pass, made to run one at a time: a pass the startup sequence or a
 * test runs waits for the worker's own pass to finish, so two passes never
 * plan the same work side by side and a pass that returns has seen every send
 * that the one before it started.
 */
export const onePassAtATime = <P extends Pass>(
  pass: Effect.Effect<P>,
): Effect.Effect<Effect.Effect<P>> =>
  Effect.map(Semaphore.make(1), (permit) => permit.withPermits(1)(pass));

/**
 * When the pass after one that began at `began` and ran to its end is due,
 * counted from when that pass looked, not from when it ended: what comes due
 * while a pass runs is done once the pass ends, and a pass that ran long has
 * spent part of its wait already.
 */
const nextPassAt = (
  result: Extract<Pass, { readonly _tag: "done" }>,
  began: DateTime.Utc,
): DateTime.Utc => {
  const retry = DateTime.addDuration(began, RETRY_TICK);
  const base = result.deferred ? retry : DateTime.addDuration(began, HEARTBEAT);
  if (result.next === null) return base;
  // Due already when the pass looked, and not done by it: left for a later one.
  const due = DateTime.isGreaterThan(result.next, began) ? result.next : retry;
  return DateTime.min(base, due);
};

/** Waits until `at`, or until a signal comes first. */
export const waitUntil = (at: DateTime.Utc, next: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    if (DateTime.isGreaterThan(at, now)) {
      yield* next.pipe(Effect.timeoutOption(DateTime.distance(now, at)));
    }
  });

/** Runs a pass, logging a failure, which yields `null`. */
const supervisedPass = <P extends Pass>(name: string, pass: Effect.Effect<P>) =>
  pass.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.as(Effect.logError(`${name} failed; it runs again later`, cause), null),
    ),
  );

/**
 * A worker that reconciles durable state (`docs/architecture/server.md`, The
 * workers). Each pass rereads the database and does what is due. A signal
 * only shortens the wait before the next pass: a pass also runs at the
 * earliest durable deadline, a few seconds after one that left due work, and
 * at a slow heartbeat otherwise, so a timeout, a readiness change or a lost
 * signal never leaves work waiting. A pass that fails unexpectedly is logged
 * and the worker waits before the next one, so a defect never spins and never
 * stops the other workers.
 *
 * What changes while a pass runs counts from when the pass began: its
 * deadlines (`nextPassAt`), a signal, and, for a pass the engine refused, the
 * engine becoming ready again. A signal fired before the pass began is
 * forgotten: the pass reads what it was for.
 */
export const reconcile = (input: {
  readonly name: string;
  readonly pass: Effect.Effect<Pass>;
  readonly signal: Trigger;
  readonly readiness: Readiness["Service"];
}): Effect.Effect<never> =>
  Effect.gen(function* () {
    yield* input.readiness.released;
    const generation = yield* input.readiness.generation;
    yield* input.signal.clear;
    const began = yield* DateTime.now;
    const result = yield* supervisedPass(input.name, input.pass);
    if (result === null) return yield* Effect.sleep(DEFECT_RETRY);
    if (result._tag === "unavailable") return yield* input.readiness.changeOrRetry(generation);
    yield* waitUntil(nextPassAt(result, began), input.signal.next);
  }).pipe(Effect.forever, Effect.withSpan(input.name));

/**
 * A reconciler whose work never goes to the engine, such as push delivery:
 * it runs whether or not the engine is ready.
 */
export const reconcileWithoutEngine = (input: {
  readonly name: string;
  readonly pass: Effect.Effect<Extract<Pass, { readonly _tag: "done" }>>;
  readonly signal: Trigger;
}): Effect.Effect<never> =>
  Effect.gen(function* () {
    yield* input.signal.clear;
    const began = yield* DateTime.now;
    const result = yield* supervisedPass(input.name, input.pass);
    if (result === null) return yield* Effect.sleep(DEFECT_RETRY);
    yield* waitUntil(nextPassAt(result, began), input.signal.next);
  }).pipe(Effect.forever, Effect.withSpan(input.name));
