// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
    /**
     * Runs `effect` as `paused` does. When `keep` says so of its answer, every
     * new first send stays held after it, until the server stops or `lease`
     * has passed: what lets the service be stopped with nothing begun since
     * none ran. The lease lets them go if the stop never comes.
     */
    readonly held: <A>(
      effect: Effect.Effect<A>,
      keep: (answer: A) => boolean,
      lease: Duration.Input,
    ) => Effect.Effect<A>;
  }
>()("@j3-bots/server/turns/SendPause") {}

export const layer = Layer.effect(
  SendPause,
  Effect.gen(function* () {
    const lock = yield* TxReentrantLock.make();
    // A hold outlives the request that took it, up to the server's stop: the
    // sender, built on this, has stopped by the time this scope closes.
    const scope = yield* Effect.scope;
    return SendPause.of({
      sending: Effect.fn("SendPause.sending")(function* <A, E, R>(send: Effect.Effect<A, E, R>) {
        return yield* TxReentrantLock.withReadLock(lock, send);
      }),
      paused: Effect.fn("SendPause.paused")(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
        return yield* TxReentrantLock.withWriteLock(lock, effect);
      }),
      held: Effect.fn("SendPause.held")(function* <A>(
        effect: Effect.Effect<A>,
        keep: (answer: A) => boolean,
        lease: Duration.Input,
      ) {
        const answered = yield* Deferred.make<A>();
        yield* TxReentrantLock.withWriteLock(
          lock,
          Effect.gen(function* () {
            const answer = yield* Effect.exit(effect);
            yield* Deferred.done(answered, answer);
            if (Exit.isSuccess(answer) && keep(answer.value)) yield* Effect.sleep(lease);
          }),
        ).pipe(Effect.forkIn(scope));
        return yield* Deferred.await(answered);
      }),
    });
  }),
);
