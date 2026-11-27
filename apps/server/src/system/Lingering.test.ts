// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Real listeners, one unreferenced, for Node's own diagnostic report to list.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { holdersIn, type Lingering, watchStop } from "./Lingering.ts";

/** A listener at `where` for as long as the scope lives, unreferenced if asked. */
const listener = (where: NodeNet.ListenOptions, referenced: boolean) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer();
      server.listen(where, () => {
        if (!referenced) server.unref();
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

/** A listener on loopback, unreferenced if asked; its port. */
const listening = (referenced: boolean) =>
  listener({ port: 0, host: "127.0.0.1" }, referenced).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address !== null && typeof address === "object"
        ? Effect.succeed(address.port)
        : Effect.die(new Error("A listener on loopback has no port"));
    }),
  );

/**
 * A listener on a pipe: a Unix socket in a temporary folder, or a named pipe
 * on Windows, which has no sockets in folders. Its path.
 */
const listeningOnPipe = Effect.gen(function* () {
  const path =
    process.platform === "win32"
      ? String.raw`\\.\pipe\j3-bots-lingering-${NodeCrypto.randomUUID()}`
      : (yield* Path.Path).join(
          yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
          "held.sock",
        );
  yield* listener({ path }, true);
  return path;
});

describe("what keeps a stopping server's process running", () => {
  it.live("names what holds the process by where it listens, and leaves out what does not", () =>
    Effect.gen(function* () {
      const held = yield* listening(true);
      const unreferenced = yield* listening(false);
      const pipe = yield* listeningOnPipe;

      const holding = holdersIn(process.report.getReport());

      assert.isTrue(Option.isSome(holding));
      const named = Option.getOrElse(holding, () => []);
      assert.include(named, `tcp on 127.0.0.1:${held}`);
      assert.include(named, `pipe on ${pipe}`);
      assert.notInclude(named, `tcp on 127.0.0.1:${unreferenced}`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says, once a stop runs long, whether everything was released and what still holds", () =>
    Effect.gen(function* () {
      const held = yield* listening(true);
      const said = yield* Deferred.make<Lingering>();
      const stopping = yield* watchStop(Duration.millis(20), (lingering) =>
        Deferred.succeed(said, lingering).pipe(Effect.asVoid),
      );

      yield* stopping.begun;
      yield* stopping.released;
      const lingering = yield* Deferred.await(said);

      assert.isTrue(lingering.released);
      assert.include(lingering.holding ?? [], `tcp on 127.0.0.1:${held}`);
    }).pipe(Effect.scoped),
  );
});
