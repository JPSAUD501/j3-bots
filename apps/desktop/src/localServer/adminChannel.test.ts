// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A stand-in for the server's admin listener, and the socket a child would inherit.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as AdminChannel from "./adminChannel.ts";

const STATUS = JSON.stringify({
  version: "0.3.0",
  pid: 4242,
  listener: { address: "127.0.0.1", port: 3747 },
  engine: { state: { _tag: "ready" } },
  webClient: "not-built",
});

/**
 * An admin listener on a socket in a fresh folder that answers `answer` for
 * each route, and the connections it took.
 */
const listener = (answer: (route: string) => { readonly status: number; readonly body: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const socketPath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-admin-" }),
      "admin.sock",
    );
    let connections = 0;
    const server = NodeHttp.createServer((request, response) => {
      const { status, body } = answer(request.url ?? "");
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    // As the server's own admin listener: a connection stays open between requests.
    server.keepAliveTimeout = 0;
    server.on("connection", () => (connections += 1));
    yield* Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
    });
    yield* Effect.addFinalizer(() =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
    );
    return { socketPath, server, connections: () => connections };
  });

const ok = (route: string) =>
  route === AdminChannel.ADMIN_ROUTES.status
    ? { status: 200, body: STATUS }
    : { status: 202, body: "{}" };

/** A socket to `socketPath`, as the app holds the pipe its child inherits. */
const connected = (socketPath: string) =>
  Effect.callback<NodeNet.Socket>((resume) => {
    const socket = NodeNet.connect(socketPath, () => resume(Effect.succeed(socket)));
  });

describe("the admin channel", () => {
  it.live("reads the server's status, ignoring what this release does not know", () =>
    Effect.gen(function* () {
      const { socketPath } = yield* listener(ok);
      const status = yield* AdminChannel.overSocket(socketPath).status();
      assert.deepStrictEqual(status, {
        version: "0.3.0",
        pid: 4242,
        listener: { address: "127.0.0.1", port: 3747 },
        engine: { state: { _tag: "ready" } },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("counts an answer it cannot read, or a refusal, as refused", () =>
    Effect.gen(function* () {
      const { socketPath } = yield* listener((route) =>
        route === AdminChannel.ADMIN_ROUTES.status
          ? { status: 200, body: '{"version": 3}' }
          : { status: 400, body: '{"error": "bad request"}' },
      );
      const channel = AdminChannel.overSocket(socketPath);
      const unreadable = yield* Effect.flip(channel.status());
      assert.instanceOf(unreadable, AdminChannel.AdminRefused);
      assert.strictEqual(unreadable.status, 200);
      const refused = yield* Effect.flip(
        channel.localDevice({ name: "workstation", replaces: null }),
      );
      assert.instanceOf(refused, AdminChannel.AdminRefused);
      assert.strictEqual(refused.status, 400);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("answers unreachable when no server listens", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-admin-" });
      const error = yield* Effect.flip(
        AdminChannel.overSocket(path.join(folder, "admin.sock")).status(),
      );
      assert.strictEqual(error._tag, "AdminUnreachable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends every request over the one pipe the server inherited", () =>
    Effect.gen(function* () {
      const { socketPath, connections } = yield* listener(ok);
      const socket = yield* connected(socketPath);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
      const channel = AdminChannel.overInheritedPipe(socket);
      yield* channel.status();
      yield* channel.status();
      yield* channel.shutdown;
      assert.strictEqual(connections(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "answers unreachable at once, without dialing again, once the server closed the pipe",
    () =>
      Effect.gen(function* () {
        const { socketPath, server, connections } = yield* listener(ok);
        const socket = yield* connected(socketPath);
        const channel = AdminChannel.overInheritedPipe(socket);
        yield* channel.status();
        yield* Effect.callback<void>((resume) => {
          socket.once("close", () => resume(Effect.void));
          server.closeAllConnections();
        });
        const error = yield* Effect.flip(channel.status());
        assert.strictEqual(error._tag, "AdminUnreachable");
        assert.strictEqual(connections(), 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
