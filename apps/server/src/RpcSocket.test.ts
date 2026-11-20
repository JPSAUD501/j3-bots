// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { DeviceId, HTTP_PATHS, SocketTicketGrant } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as SqlClient from "effect/sql/SqlClient";
import * as DeviceAuth from "./auth/DeviceAuth.ts";
import * as Http from "./http.ts";
import * as RpcSocket from "./RpcSocket.ts";
import * as Ports from "./system/Ports.ts";
import * as TestDomain from "./testing/domain.ts";

const SocketRpcs = RpcGroup.make(
  Rpc.make("whoami", { success: DeviceId }),
  Rpc.make("fail", {}),
  Rpc.make("ticks", { success: Schema.Number, stream: true }),
);

class Ticks extends Context.Service<Ticks, Queue.Queue<number>>()(
  "@j3-bots/server/RpcSocket.test/Ticks",
) {}

const handlers = (queue: Queue.Queue<number>) =>
  SocketRpcs.toLayer(
    Effect.gen(function* () {
      const device = yield* DeviceAuth.CurrentDevice;
      return {
        whoami: () => Effect.succeed(device.id),
        fail: () => Effect.die(new Error("a detail the client must not see")),
        ticks: () => Stream.fromQueue(queue),
      };
    }),
  );

const TOKEN = "a-device-token-that-is-long-enough-for-the-schema";
const DEVICE = DeviceId.make("device-1");

const pairDevice = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hash = yield* DeviceAuth.hashDeviceToken(TOKEN).pipe(Effect.provide(Digest.layerWebCrypto));
  yield* sql`
    INSERT INTO devices (id, name, token_hash, paired_at)
    VALUES (${DEVICE}, 'Laptop', ${hash}, '2026-11-20T09:00:00.000Z')
  `;
});

const socketUrl = (query: string) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die("The test server listens on a TCP port");
    }
    return `ws://127.0.0.1:${address.port}${HTTP_PATHS.rpc}${query}`;
  });

const connect = (query: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const url = yield* socketUrl(query);
    // Built in the test's scope, so the socket stays open until the test ends.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(NodeSocket.layerWebSocket(url, { headers })),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(SocketRpcs).pipe(Effect.provide(protocol));
  });

const bearer = { authorization: `Bearer ${TOKEN}` };

const server = Layer.unwrap(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<number>();
    yield* pairDevice;
    return Layer.mergeAll(
      Ports.serve(
        Layer.mergeAll(Http.routes, RpcSocket.layer(SocketRpcs, handlers(queue))),
        NodeHttpServer.layerTest,
        { logAddress: false },
      ),
      Layer.succeed(Ticks, queue),
    );
  }),
).pipe(Layer.provideMerge(TestDomain.layer));

it.layer(server, { excludeTestServices: true })("RPC socket", (it) => {
  it.effect("refuses an upgrade without a valid credential", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.get(HTTP_PATHS.rpc);
      const wrong = yield* HttpClient.get(HTTP_PATHS.rpc, {
        headers: { authorization: "Bearer not-a-device-token" },
      });

      assert.strictEqual(missing.status, 401);
      assert.strictEqual(wrong.status, 401);
    }),
  );

  it.effect("binds the socket to the device that opened it, with a ticket that works once", () =>
    Effect.gen(function* () {
      const grant = yield* HttpClientRequest.post(HTTP_PATHS.socketTicket).pipe(
        HttpClientRequest.setHeaders(bearer),
        HttpClient.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SocketTicketGrant)),
      );
      const query = `?ticket=${encodeURIComponent(grant.ticket)}`;

      const client = yield* connect(query);
      assert.strictEqual(yield* client.whoami(), DEVICE);
      const replayed = yield* HttpClient.get(`${HTTP_PATHS.rpc}${query}`);
      assert.strictEqual(replayed.status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("fails only the request that died, with a generic message", () =>
    Effect.gen(function* () {
      const queue = yield* Ticks;
      const client = yield* connect("", bearer);
      const subscription = yield* client
        .ticks()
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(queue, 1);

      const failed = yield* client.fail().pipe(Effect.exit);
      yield* Queue.offer(queue, 2);

      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed)) {
        assert.deepStrictEqual(Cause.squash(failed.cause), RpcSocket.INTERNAL_ERROR);
      }
      assert.deepStrictEqual(yield* Fiber.join(subscription), [1, 2]);
      assert.strictEqual(yield* client.whoami(), DEVICE);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the device's sockets when it is revoked", () =>
    Effect.gen(function* () {
      const auth = yield* DeviceAuth.DeviceAuth;
      const client = yield* connect("", bearer);
      const subscription = yield* client.ticks().pipe(Stream.runDrain, Effect.forkScoped);
      assert.strictEqual(yield* client.whoami(), DEVICE);

      yield* auth.revoke(DEVICE);

      const ended = yield* Fiber.await(subscription);
      assert.isTrue(Exit.isFailure(ended));
      const refused = yield* HttpClient.get(HTTP_PATHS.rpc, { headers: bearer });
      assert.strictEqual(refused.status, 401);
    }).pipe(Effect.scoped),
  );
});
