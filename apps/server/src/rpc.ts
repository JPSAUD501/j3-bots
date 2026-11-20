import { PROTOCOL_VERSION, RPC_PATH, ServerRpcs } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import packageJson from "../package.json" with { type: "json" };

const ServerHandlers = ServerRpcs.toLayer(
  Effect.gen(function* () {
    const info = {
      protocolVersion: PROTOCOL_VERSION,
      version: packageJson.version,
      startedAt: yield* DateTime.now,
    };
    return { "server.info": () => Effect.succeed(info) };
  }),
);

/** The client API: Effect RPC over a WebSocket at `RPC_PATH`, JSON frames. */
export const layer = RpcServer.layerHttp({
  group: ServerRpcs,
  path: RPC_PATH,
  protocol: "websocket",
}).pipe(Layer.provide([ServerHandlers, RpcSerialization.layerJson]));
