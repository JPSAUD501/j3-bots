// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TxReentrantLock from "effect/TxReentrantLock";

/**
 * Holds first sends while something must know that no new work reaches the
 * engine, such as an engine restart the operator agreed to only because none
 * ran (`j3-bots provider connect`).
 */
export class SendPause extends Context.Service<
  SendPause,
  {
    /** Runs a first send, after any pause under way has ended. */
    readonly sending: <A, E, R>(send: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * Runs `effect` once every first send under way has its answer recorded,
     * and holds every new one until `effect` ends.
     */
    readonly paused: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@j3-bots/server/turns/SendPause") {}

export const layer = Layer.effect(
  SendPause,
  Effect.gen(function* () {
    const lock = yield* TxReentrantLock.make();
    return SendPause.of({
      sending: Effect.fn("SendPause.sending")(function* <A, E, R>(send: Effect.Effect<A, E, R>) {
        return yield* TxReentrantLock.withReadLock(lock, send);
      }),
      paused: Effect.fn("SendPause.paused")(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
        return yield* TxReentrantLock.withWriteLock(lock, effect);
      }),
    });
  }),
);
