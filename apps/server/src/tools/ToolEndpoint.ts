// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ServerConfig } from "../config.ts";
import { BotTools } from "./BotTools.ts";
import { TOOL_CALL_PATH, ToolCallRequest, ToolCallResponse } from "./protocol.ts";

/**
 * Where the `j3` bridges forward bot tool calls. It listens on loopback only,
 * whatever `J3_HOST` is: the bridges run on this machine, started by the
 * engine's harnesses, and nothing else may reach it.
 */
export const routes = HttpRouter.add(
  "POST",
  TOOL_CALL_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.schemaBodyJson(ToolCallRequest).pipe(Effect.option);
    if (request._tag === "None") return HttpServerResponse.empty({ status: 400 });
    const tools = yield* BotTools;
    const response = yield* tools.call(request.value);
    return yield* HttpServerResponse.schemaJson(ToolCallResponse)(response).pipe(Effect.orDie);
  }),
);

const listen = Layer.unwrap(
  Effect.gen(function* () {
    const { toolPort } = yield* ServerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: toolPort,
      gracefulShutdownTimeout: "5 seconds",
    });
  }),
);

export const layer = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
  Layer.provide(listen),
);
