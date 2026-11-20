// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Another program holding the engine's port is a plain node:net server.
import * as NodeNet from "node:net";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type ProcessState, stateChanges, supervise } from "./Supervisor.ts";

/** A loopback port a program that is not an engine listens on, for as long as the test runs. */
const heldPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return address !== null && typeof address === "object" ? address.port : 0;
  }),
);

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

  it.effect("waits for a port another program holds instead of starting the engine there", () =>
    Effect.gen(function* () {
      const port = yield* heldPort;
      const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
      let starts = 0;
      yield* supervise({
        executable: "/nonexistent/t3",
        home: "/nonexistent/home",
        port,
        state,
        // Nothing on the port answers as an engine (the HTTP client fails), yet it is taken.
        beforeStart: Effect.sync(() => {
          starts++;
        }),
        checkAccess: Effect.succeed("granted"),
        reissueCredential: Effect.void,
      });

      const waiting = yield* stateChanges(state).pipe(
        Stream.filter((current) => current._tag === "unavailable"),
        Stream.runHead,
      );
      assert.deepStrictEqual(Option.getOrUndefined(waiting), {
        _tag: "unavailable",
        reason: "port-in-use",
      });
      assert.strictEqual(starts, 0);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
