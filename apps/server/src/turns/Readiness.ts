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
  /**
   * The engine start it last ran for (`Engine.starts`), 0 before the first: a
   * loop parked behind an unready engine waits for a later one.
   */
  readonly generation: number;
}

/**
 * Whether the turn machinery may send the engine anything
 * (`docs/architecture/server.md`, Failure handling). `Turns` closes it when
 * the engine stops being ready and releases it once every session's events
 * are followed again. Every worker waits on it; what each may then send into
 * one session is that worker's own rule for the session.
 */
export class Readiness extends Context.Service<
  Readiness,
  {
    /** Waits until the machinery is released. */
    readonly released: Effect.Effect<void>;
    /**
     * For a loop the engine refused in a pass that began under `generation`:
     * waits until the machinery is released under a later one, also one that
     * came while the pass ran, or the retry deadline passes, since the
     * engine's status can trail it.
     */
    readonly changeOrRetry: (generation: number) => Effect.Effect<void>;
    /**
     * The engine start the machinery was last released for (`Engine.starts`),
     * 0 before the first. An answer an older start gave came from an engine
     * that has been unready since, and may no longer hold.
     */
    readonly generation: Effect.Effect<number>;
    /** The startup sequence has run for the engine start `start`. */
    readonly release: (start: number) => Effect.Effect<void>;
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

    const changeOrRetry = Effect.fn("Readiness.changeOrRetry")(function* (generation: number) {
      yield* waitFor((current) => current.released && current.generation > generation).pipe(
        Effect.timeoutOption(UNAVAILABLE_RETRY),
      );
      yield* released;
    });

    return Readiness.of({
      released,
      changeOrRetry,
      generation: SubscriptionRef.get(state).pipe(Effect.map((current) => current.generation)),
      release: Effect.fn("Readiness.release")((start: number) =>
        SubscriptionRef.update(state, (current) => ({
          released: true,
          generation: Math.max(current.generation, start),
        })),
      ),
      hold: SubscriptionRef.update(state, (current) => ({ ...current, released: false })),
    });
  }),
);
