// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
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
 * Any program on this machine can reach the endpoint, so a body is read only
 * this far. The largest argument a tool takes is a memory file of 200,000
 * characters, under 1.2 MB as escaped JSON.
 */
const TOOL_CALL_BODY_LIMIT = 4 * 1024 * 1024;

const decodeToolCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallRequest));

/**
 * Whether a request is made the way the bridge makes it: to `127.0.0.1` at
 * the port it arrived on, written as a URL writes it, with a JSON body and no
 * `Origin`. A web page in a browser on this machine can reach loopback too,
 * and a browser sends a POST's `Origin`, a page on a name rebound to loopback
 * sends that name as `Host`, and a JSON content type from another origin
 * needs a preflight the endpoint never answers.
 */
const fromBridge = (request: HttpServerRequest.HttpServerRequest) => {
  const port = NodeHttpServerRequest.toIncomingMessage(request).socket.localPort;
  return (
    port !== undefined &&
    request.headers["host"] === new URL(`http://127.0.0.1:${port}`).host &&
    request.headers["origin"] === undefined &&
    request.headers["content-type"] === "application/json"
  );
};

/**
 * Where the `j3` bridges forward bot tool calls. It listens on loopback only,
 * whatever `J3_HOST` is: the bridges run on this machine, started by the
 * engine's harnesses, and a request made any other way is refused before its
 * body is read.
 */
export const routes = HttpRouter.add(
  "POST",
  TOOL_CALL_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromBridge(request)) return HttpServerResponse.empty({ status: 403 });
    const body = yield* readText(request, TOOL_CALL_BODY_LIMIT).pipe(Effect.result);
    if (body._tag === "Failure") {
      return HttpServerResponse.empty({ status: body.failure._tag === "BodyTooLarge" ? 413 : 400 });
    }
    const call = yield* decodeToolCall(body.success).pipe(Effect.option);
    if (call._tag === "None") return HttpServerResponse.empty({ status: 400 });
    const tools = yield* BotTools;
    return yield* tools.call(call.value).pipe(
      Effect.flatMap((response) =>
        HttpServerResponse.schemaJson(ToolCallResponse)(response).pipe(Effect.orDie),
      ),
      // Not matched yet, and nothing recorded: the bridge forwards it again.
      Effect.catchTag("TurnToolRetry", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      ),
    );
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

const served = Ports.serve(routes, listen, { logAddress: false });

/** The endpoint, listening. Its server is its own: the layer offers nothing. */
export const layer: Layer.Layer<
  never,
  Layer.Error<typeof served>,
  Layer.Services<typeof served>
> = served;
