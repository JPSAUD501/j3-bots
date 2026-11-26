// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

/**
 * A nudge for a worker that reads its work from the database: firing it twice
 * before the worker looks is the same as firing it once. A worker never
 * depends on a nudge for correctness, only for promptness: what it does is
 * read from the database, which is where the cause was written, and it looks
 * again on its own (`reconciler.ts`). A nudge is fired only when state
 * changed, so a pass that changed nothing causes no other pass.
 */
export interface Trigger {
  readonly fire: Effect.Effect<void>;
  /** Waits for the next nudge. */
  readonly next: Effect.Effect<void>;
  /** Forgets a nudge not yet taken: for a pass about to begin, which reads what it was for. */
  readonly clear: Effect.Effect<void>;
}

const makeTrigger = Effect.gen(function* () {
  const queue = yield* Queue.sliding<void>(1);
  return {
    fire: Queue.offer(queue, undefined).pipe(Effect.asVoid),
    next: Queue.take(queue),
    clear: Queue.poll(queue).pipe(Effect.asVoid),
  } satisfies Trigger;
});

/**
 * The turn machinery's workers, and what nudges each: the dispatcher (a wake
 * was written, or a session may have become idle), the recovery of
 * dispatches whose answer was lost, the Stop runner, the responder that sends
 * the operator's answers to engine requests, the resumer of held queues, the
 * rotator of main sessions, and the routine runner (a routine's wake was
 * written, or a run's work ended); and, outside the turn machinery, the push
 * delivery worker (a notification to push was written).
 */
export class Signals extends Context.Service<
  Signals,
  {
    readonly dispatch: Trigger;
    readonly recovery: Trigger;
    readonly stops: Trigger;
    readonly responses: Trigger;
    readonly resumes: Trigger;
    readonly rotations: Trigger;
    readonly routines: Trigger;
    readonly push: Trigger;
  }
>()("@j3-bots/server/turns/Signals") {}

export const layer = Layer.effect(
  Signals,
  Effect.gen(function* () {
    return Signals.of({
      dispatch: yield* makeTrigger,
      recovery: yield* makeTrigger,
      stops: yield* makeTrigger,
      responses: yield* makeTrigger,
      resumes: yield* makeTrigger,
      rotations: yield* makeTrigger,
      routines: yield* makeTrigger,
      push: yield* makeTrigger,
    });
  }),
);
