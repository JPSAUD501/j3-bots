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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Sink from "effect/Sink";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePrivateFiles } from "./PrivateFiles.ts";
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
  SecureRandom.layerWebCrypto,
);

const files = makePrivateFiles(() => Effect.succeed(true));

/**
 * A machine whose engine, once started, runs until stopped and answers as a
 * release J3 Bots does not pin.
 */
const incompatibleMachine = () => {
  let started = false;
  const descriptor = JSON.stringify({
    environmentId: "environment-other",
    label: "Other",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-other",
    capabilities: {},
  });
  return Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        started
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(descriptor, { headers: { "content-type": "application/json" } }),
              ),
            )
          : Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            ),
      ),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          started = true;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4242),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      ),
    ),
    FileSystem.layerNoop({}),
    Path.layer,
    SecureRandom.layerWebCrypto,
  );
};

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
        files: yield* files,
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
        files: yield* files,
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

  it.effect("answers a restart at once when the engine it started was incompatible", () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
      const supervision = yield* supervise({
        executable: "/nonexistent/t3",
        home: "/nonexistent/home",
        port: 1,
        state,
        beforeStart: Effect.void,
        checkAccess: Effect.succeed("granted"),
        reissueCredential: Effect.void,
        files: yield* files,
      });
      yield* stateChanges(state).pipe(
        Stream.filter((current) => current._tag === "incompatible"),
        Stream.runHead,
      );

      // Nothing starts the engine again, so nothing would ever answer it.
      assert.strictEqual(yield* supervision.restart, false);
    }).pipe(Effect.scoped, Effect.provide(incompatibleMachine())),
  );
});
