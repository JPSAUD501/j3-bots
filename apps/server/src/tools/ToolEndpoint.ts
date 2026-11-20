// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { readText } from "../body.ts";
import { ServerConfig } from "../config.ts";
import * as Ports from "../system/Ports.ts";
import { BotTools } from "./BotTools.ts";
import { TOOL_CALL_PATH, ToolCallRequest, ToolCallResponse } from "./protocol.ts";

/**
 * Where the `j3` bridges forward bot tool calls. It listens on loopback only,
 * whatever `J3_HOST` is: the bridges run on this machine, started by the
 * engine's harnesses, and nothing else may reach it.
 */
/**
 * Any program on this machine can reach the endpoint, so a body is read only
 * this far. The largest argument a tool takes is a memory file of 200,000
 * characters, under 1.2 MB as escaped JSON.
 */
const TOOL_CALL_BODY_LIMIT = 4 * 1024 * 1024;

const decodeToolCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallRequest));

export const routes = HttpRouter.add(
  "POST",
  TOOL_CALL_PATH,
  Effect.gen(function* () {
    const body = yield* readText(
      yield* HttpServerRequest.HttpServerRequest,
      TOOL_CALL_BODY_LIMIT,
    ).pipe(Effect.result);
    if (body._tag === "Failure") {
      return HttpServerResponse.empty({ status: body.failure._tag === "BodyTooLarge" ? 413 : 400 });
    }
    const request = yield* decodeToolCall(body.success).pipe(Effect.option);
    if (request._tag === "None") return HttpServerResponse.empty({ status: 400 });
    const tools = yield* BotTools;
    const response = yield* tools.call(request.value);
    return yield* HttpServerResponse.schemaJson(ToolCallResponse)(response).pipe(Effect.orDie);
  }),
);

const listen = Layer.unwrap(
  Effect.gen(function* () {
    const { toolPort, configFile } = yield* ServerConfig;
    const host = "127.0.0.1";
    return Ports.listen(
      () => NodeHttp.createServer(),
      { host, port: toolPort, gracefulShutdownTimeout: "5 seconds" },
      { label: "the bot tools", setting: "toolPort", host, port: toolPort },
      configFile,
    );
  }),
);

export const layer = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
  Layer.provide(listen),
);
