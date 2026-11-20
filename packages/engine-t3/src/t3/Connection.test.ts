// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import { makeEngineRpc } from "./Connection.ts";

const unreachable = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request }),
    }),
  ),
);

describe("makeEngineRpc", () => {
  it.effect("closes while the first dial still waits for a credential", () =>
    Effect.gen(function* () {
      const dialing = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* makeEngineRpc({
        port: 1,
        // The engine never mints one: it failed before it could.
        token: Deferred.succeed(dialing, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Scope.provide(scope), Effect.provideService(HttpClient.HttpClient, unreachable));
      yield* Deferred.await(dialing);

      // Returns only once the dial has been abandoned.
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
