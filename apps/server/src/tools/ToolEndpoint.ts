// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { readText } from "../body.ts";
import { ServerConfig } from "../config.ts";
import * as Ports from "../system/Ports.ts";
import { BotTools } from "./BotTools.ts";
import {
  TOOL_CALL_PATH,
  TOOL_CHANGES_PATH,
  TOOL_LIST_PATH,
  ToolCallRequest,
  ToolCallResponse,
  ToolChangesRequest,
  ToolChangesResponse,
  ToolListRequest,
  ToolListResponse,
} from "./protocol.ts";
import { ToolLists } from "./ToolLists.ts";

/**
 * Any program on this machine can reach the endpoint, so a body is read only
 * this far. The largest argument a tool takes is a memory file of 200,000
 * characters, under 1.2 MB as escaped JSON.
 */
const TOOL_CALL_BODY_LIMIT = 4 * 1024 * 1024;

/** The most a list or changes request weighs: a session id and a version. */
const SMALL_BODY_LIMIT = 4 * 1024;

/**
 * Whether a request is made the way the bridge makes it: to `127.0.0.1` at
 * the port it arrived on, written as a URL writes it, with a JSON body and no
 * `Origin`. Its `Host` holds an absolute request target's authority when it
 * has one: the adapter puts it there. A web page in a browser on this machine can reach loopback too,
 * and a browser sends a POST's `Origin`, a page on a name rebound to loopback
 * sends that name as `Host`, and a JSON content type from another origin
 * needs a preflight the endpoint never grants.
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
 * A route that takes a request only as the bridge makes it, with a JSON body
 * of at most `limit` bytes that decodes as `request`, and answers what
 * `handle` gives, as `response`.
 */
const bridgeRoute = <I, IE, O, OE, E, R>(
  path: HttpRouter.PathInput,
  limit: number,
  request: Schema.Codec<I, IE>,
  response: Schema.Codec<O, OE>,
  handle: (input: I) => Effect.Effect<O | HttpServerResponse.HttpServerResponse, E, R>,
) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(request));
  const encode = HttpServerResponse.schemaJson(response);
  return HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const incoming = yield* HttpServerRequest.HttpServerRequest;
      if (!fromBridge(incoming)) return HttpServerResponse.empty({ status: 403 });
      const body = yield* readText(incoming, limit).pipe(Effect.result);
      if (body._tag === "Failure") {
        return HttpServerResponse.empty({
          status: body.failure._tag === "BodyTooLarge" ? 413 : 400,
        });
      }
      const input = yield* decode(body.success).pipe(Effect.option);
      if (input._tag === "None") return HttpServerResponse.empty({ status: 400 });
      const output = yield* handle(input.value);
      return HttpServerResponse.isHttpServerResponse(output)
        ? output
        : yield* encode(output).pipe(Effect.orDie);
    }),
  );
};

/**
 * Where the `j3` bridges list their session's tools, wait for that list to
 * change, and forward bot tool calls. It listens on loopback only, whatever
 * `J3_HOST` is: the bridges run on this machine, started by the engine's
 * harnesses, and a request made any other way is refused before its body is
 * read.
 */
export const routes = Layer.mergeAll(
  bridgeRoute(TOOL_CALL_PATH, TOOL_CALL_BODY_LIMIT, ToolCallRequest, ToolCallResponse, (call) =>
    Effect.gen(function* () {
      const tools = yield* BotTools;
      return yield* tools.call(call).pipe(
        // Not matched yet, and nothing recorded: the bridge forwards it again.
        Effect.catchTag("TurnToolRetry", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        ),
      );
    }),
  ),
  bridgeRoute(TOOL_LIST_PATH, SMALL_BODY_LIMIT, ToolListRequest, ToolListResponse, (request) =>
    Effect.gen(function* () {
      return yield* (yield* ToolLists).list(request.sessionId);
    }),
  ),
  bridgeRoute(
    TOOL_CHANGES_PATH,
    SMALL_BODY_LIMIT,
    ToolChangesRequest,
    ToolChangesResponse,
    (request) =>
      Effect.gen(function* () {
        const change = yield* (yield* ToolLists).changes(request);
        // No bot's session: the bridge stops waiting for changes.
        return Option.getOrElse(change, () => HttpServerResponse.empty({ status: 404 }));
      }),
  ),
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
