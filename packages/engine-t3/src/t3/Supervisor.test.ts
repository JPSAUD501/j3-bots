// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type ProcessState, supervise } from "./Supervisor.ts";

// Nothing answers on the engine's port, and no process may be started: the
// tests stop the supervisor before it would spawn one.
const machine = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    ),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die(new Error("The test starts no process"))),
  ),
  FileSystem.layerNoop({}),
  Path.layer,
);

describe("supervise", () => {
  it.effect("stops when its scope closes while a start is under way", () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
      const preparing = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* supervise({
        executable: "/nonexistent/t3",
        home: "/nonexistent/home",
        port: 1,
        state,
        // The engine's preparation never finishes, so the scope closes inside a run.
        beforeStart: Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never)),
        checkAccess: Effect.succeed("granted"),
        reissueCredential: Effect.void,
      }).pipe(Scope.provide(scope));
      yield* Deferred.await(preparing);

      // Returns only once the supervision loop has ended.
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(machine)),
  );
});
