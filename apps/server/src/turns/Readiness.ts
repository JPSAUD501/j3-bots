// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { UNAVAILABLE_RETRY } from "./model.ts";

interface State {
  /** The startup or reconnect sequence has run since the engine last became ready. */
  readonly released: boolean;
  /** How many times it has: a loop parked behind an unready engine waits for the next. */
  readonly generation: number;
}

/**
 * Whether the turn machinery may send the engine anything new
 * (`docs/architecture/server.md`, Failure handling). `Turns` closes it when
 * the engine stops being ready and releases it once it has sent the Stops,
 * caught up the events, recovered what was left undecided and resumed the
 * held queues, in that order. The dispatcher, the recovery and the Stop
 * runner wait on it, so none of them runs ahead of that order.
 */
export class Readiness extends Context.Service<
  Readiness,
  {
    /** Waits until the machinery is released. */
    readonly released: Effect.Effect<void>;
    /**
     * For a loop the engine just refused: waits until the machinery is
     * released again after the engine was unready, or the retry deadline
     * passes, since the engine's status can trail it.
     */
    readonly changeOrRetry: Effect.Effect<void>;
    readonly release: Effect.Effect<void>;
    readonly hold: Effect.Effect<void>;
  }
>()("@j3-bots/server/turns/Readiness") {}

export const layer = Layer.effect(
  Readiness,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<State>({ released: false, generation: 0 });

    const waitFor = (holds: (current: State) => boolean) =>
      SubscriptionRef.changes(state).pipe(Stream.filter(holds), Stream.runHead, Effect.asVoid);

    const released = waitFor((current) => current.released);

    const changeOrRetry = Effect.gen(function* () {
      const { generation } = yield* SubscriptionRef.get(state);
      yield* waitFor((current) => current.released && current.generation > generation).pipe(
        Effect.timeoutOption(UNAVAILABLE_RETRY),
      );
      yield* released;
    });

    return Readiness.of({
      released,
      changeOrRetry,
      release: SubscriptionRef.update(state, (current) => ({
        released: true,
        generation: current.released ? current.generation : current.generation + 1,
      })),
      hold: SubscriptionRef.update(state, (current) => ({ ...current, released: false })),
    });
  }),
);
