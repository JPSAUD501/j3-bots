// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Another program holding the port is a plain node:net server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Ports from "./Ports.ts";

const USE = { label: "the server", setting: "port", host: "127.0.0.1", port: 0 } as const;
const CONFIG_FILE = "/home/pi/.j3-bots/config.json";

/** The port `context`'s server listens on. */
const portOf = (context: Context.Context<HttpServer.HttpServer>) => {
  const { address } = Context.get(context, HttpServer.HttpServer);
  return NetAddress.isInetAddress(address) ? address.port : 0;
};

/** A port another program listens on, for as long as the test runs. */
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

it.effect("names the port and the setting when another program holds it", () =>
  Effect.gen(function* () {
    const port = yield* heldPort;
    const exit = yield* Layer.build(
      Ports.listen(
        () => NodeHttp.createServer(),
        { host: "127.0.0.1", port },
        { label: "the bot tools", setting: "toolPort", host: "127.0.0.1", port },
        CONFIG_FILE,
      ),
    ).pipe(Effect.exit);
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    assert.isTrue(Option.isSome(error));
    if (Option.isSome(error)) {
      assert.strictEqual(error.value.code, "EADDRINUSE");
      assert.include(error.value.message, `Port ${port}, for the bot tools, is in use`);
      assert.include(error.value.message, '"toolPort" in /home/pi/.j3-bots/config.json');
    }
  }).pipe(Effect.scoped),
);

it.live("answers a request sent the moment the port accepts connections", () =>
  Effect.gen(function* () {
    const first = Promise.withResolvers<number>();
    // The request leaves as soon as the server has bound, before anything is
    // served on it.
    const server = Ports.listen(
      () => NodeHttp.createServer(),
      { host: "127.0.0.1", port: 0 },
      USE,
      CONFIG_FILE,
    ).pipe(
      Layer.tap((context) =>
        Effect.sync(() => {
          NodeHttp.get({ host: "127.0.0.1", port: portOf(context), path: "/" }, (response) => {
            response.resume();
            first.resolve(response.statusCode ?? 0);
          }).on("error", first.reject);
        }),
      ),
    );
    // Routes whose build waits on the filesystem, as the web client's does.
    const app = Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (let read = 0; read < 20; read++) yield* fs.stat(".");
        return HttpRouter.add("GET", "/", HttpServerResponse.empty());
      }),
    );
    yield* Layer.build(
      Ports.serve(app, server, { logAddress: false }).pipe(Layer.provide(NodeServices.layer)),
    );
    assert.strictEqual(yield* Effect.promise(() => first.promise), 204);
  }).pipe(Effect.scoped),
);

it.live(
  "ends a connection whose request never finished arriving once the grace period is over",
  () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer();
      const accepted = new Promise<void>((resolve) => server.once("connection", () => resolve()));
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        Ports.serve(
          HttpRouter.add("GET", "/", HttpServerResponse.empty()),
          Ports.listen(
            () => server,
            { host: "127.0.0.1", port: 0, gracefulShutdownTimeout: "20 millis" },
            USE,
            CONFIG_FILE,
          ),
          { logAddress: false },
        ),
        scope,
      );

      // Headers that never end: Node counts the request as active, so its own
      // close waits for it (until `headersTimeout`, a minute).
      const client = NodeNet.connect({ host: "127.0.0.1", port: portOf(context) });
      client.on("error", () => {});
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
      yield* Effect.promise(() => accepted);

      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => closed);
    }),
);
