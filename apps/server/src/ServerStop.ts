// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A stop of the server asked for from inside it: by `POST /shutdown` on the
 * admin channel, or by the end of stdin under `--exit-with-stdin`. `serve`
 * waits on it and then releases the server as SIGTERM does, so either way the
 * engine and its harnesses stop and the home's lock is released.
 */
export class ServerStop extends Context.Service<
  ServerStop,
  {
    /** Asks for the stop and returns at once. A second request changes nothing. */
    readonly request: Effect.Effect<void>;
    /** Completes once a stop was asked for. */
    readonly requested: Effect.Effect<void>;
  }
>()("@j3-bots/server/ServerStop") {}

export const layer = Layer.effect(
  ServerStop,
  Effect.gen(function* () {
    const stop = yield* Deferred.make<void>();
    return ServerStop.of({
      request: Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
      requested: Deferred.await(stop),
    });
  }),
);
