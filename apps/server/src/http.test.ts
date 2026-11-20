import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { PROTOCOL_VERSION, RPC_PATH, ServerRpcs } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Http from "./http.ts";

const rpcProtocol = Layer.unwrap(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die("The test server listens on a TCP port");
    }
    return RpcClient.layerProtocolSocket().pipe(
      Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${address.port}${RPC_PATH}`)),
      Layer.provide(RpcSerialization.layerJson),
    );
  }),
);

it.layer(
  Layer.mergeAll(Http.layer, rpcProtocol).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
)("http", (it) => {
  it.effect("answers the health check", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/health");
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* response.json, { status: "ok" });
    }),
  );

  it.effect("answers server.info over the WebSocket RPC endpoint", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(ServerRpcs);
      const info = yield* client["server.info"]();
      assert.strictEqual(info.protocolVersion, PROTOCOL_VERSION);
      assert.isTrue(DateTime.isDateTime(info.startedAt));
    }).pipe(Effect.scoped),
  );
});
