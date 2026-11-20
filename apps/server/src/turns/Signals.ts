// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

/**
 * A nudge for a loop that reads its work from the database: firing it twice
 * before the loop looks is the same as firing it once, and firing it when
 * there is nothing to do costs one empty pass. A loop never depends on a nudge
 * for correctness, only for promptness: what it does is read from the
 * database, which is where the cause was written.
 */
export interface Trigger {
  readonly fire: Effect.Effect<void>;
  /** Waits for the next nudge. */
  readonly next: Effect.Effect<void>;
}

const makeTrigger = Effect.gen(function* () {
  const queue = yield* Queue.sliding<void>(1);
  return {
    fire: Queue.offer(queue, undefined).pipe(Effect.asVoid),
    next: Queue.take(queue),
  } satisfies Trigger;
});

/**
 * The turn machinery's loops, and what wakes each: the dispatcher (a wake was
 * written, or a session may have become idle), the recovery of dispatches
 * whose answer was lost, the Stop runner, and the responder that sends the
 * operator's answers to engine requests.
 */
export class Signals extends Context.Service<
  Signals,
  {
    readonly dispatch: Trigger;
    readonly recovery: Trigger;
    readonly stops: Trigger;
    readonly responses: Trigger;
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
    });
  }),
);
