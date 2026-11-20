// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SessionId } from "@j3-bots/engine-t3";
import { toolList } from "@j3-bots/prompts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TOOL_CALL_PATH, ToolCallRequest, ToolCallResponse } from "../tools/protocol.ts";

/** The MCP revision answered when the client names none. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** How long one call keeps trying to reach the server before it gives up. */
const FORWARD_DEADLINE = Duration.seconds(30);

const RpcId = Schema.Union([Schema.String, Schema.Number]);

/** A JSON-RPC request or notification. Responses from the client are ignored. */
const Incoming = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(RpcId),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
});
type Incoming = typeof Incoming.Type;

const Initialize = Schema.Struct({ protocolVersion: Schema.optionalKey(Schema.String) });
const ToolCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeOption = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownOption(schema);

const textResult = (text: string, isError: boolean): Schema.Json => ({
  content: [{ type: "text", text }],
  isError,
});

/**
 * The `j3` MCP server a harness starts for every session: a stdio process that
 * lists the bot tools and forwards each call to the J3 Bots server's tool
 * endpoint on loopback. It keeps nothing and does nothing of its own
 * (`docs/architecture/server.md`, Bot tools). A forward keeps one id across
 * its retries, so the server acts on a call once however often it arrives.
 */
export const serve = Effect.fn("Bridge.serve")(function* (options: {
  /** The tool endpoint's origin, such as `http://127.0.0.1:3739`. */
  readonly server: string;
  /** The session that started the bridge; `None` refuses every call. */
  readonly session: Option.Option<SessionId>;
  readonly version: string;
}) {
  const stdio = yield* Stdio.Stdio;
  const random = yield* SecureRandom.SecureRandom;
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      // Until the call's deadline, which ends the retries.
      schedule: Schedule.spaced("250 millis"),
    }),
  );

  const forward = Effect.fn("Bridge.forward")(function* (request: ToolCallRequest) {
    const body = yield* HttpClientRequest.post(`${options.server}${TOOL_CALL_PATH}`).pipe(
      HttpClientRequest.schemaBodyJson(ToolCallRequest)(request),
    );
    const response = yield* client.execute(body);
    return yield* HttpClientResponse.schemaBodyJson(ToolCallResponse)(response);
  });

  const callTool = Effect.fn("Bridge.callTool")(function* (params: Schema.Json | undefined) {
    const call = decodeOption(ToolCall)(params);
    if (Option.isNone(call)) return textResult("The call names no tool.", true);
    if (Option.isNone(options.session)) {
      return textResult("This bridge was not started by a J3 Bots session.", true);
    }
    const requestId = Base64Url.encode(yield* random.randomBytes(16));
    const answer = yield* forward({
      requestId,
      sessionId: options.session.value,
      tool: call.value.name,
      arguments: call.value.arguments ?? {},
    }).pipe(Effect.timeout(FORWARD_DEADLINE), Effect.option);
    if (Option.isNone(answer)) {
      return textResult("J3 Bots could not be reached. Try the call again.", true);
    }
    return answer.value._tag === "result"
      ? textResult(encodeLine(answer.value.value), false)
      : textResult(answer.value.message, true);
  });

  /** The answer to one message, or `None` for a notification. */
  const answer = Effect.fn("Bridge.answer")(function* (message: Incoming) {
    if (message.id === undefined) return Option.none<Schema.Json>();
    const respond = (result: Schema.Json): Schema.Json => ({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result,
    });
    switch (message.method) {
      case "initialize": {
        const requested = decodeOption(Initialize)(message.params);
        return Option.some(
          respond({
            protocolVersion: Option.match(requested, {
              onNone: () => DEFAULT_PROTOCOL_VERSION,
              onSome: (params) => params.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
            }),
            capabilities: { tools: {} },
            serverInfo: { name: "j3", version: options.version },
          }),
        );
      }
      case "ping":
        return Option.some(respond({}));
      case "tools/list":
        return Option.some(
          respond({
            tools: toolList.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: decodeOption(Schema.Json)(tool.inputSchema).pipe(
                Option.getOrElse((): Schema.Json => ({ type: "object" })),
              ),
            })),
          }),
        );
      case "tools/call":
        return Option.some(respond(yield* callTool(message.params)));
      default:
        return Option.some<Schema.Json>({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
    }
  });

  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    // A line that is not a JSON-RPC request or notification gets no answer.
    Stream.map((line) => decodeLine(line)),
    Stream.filter(Option.isSome),
    Stream.mapEffect((message) => answer(message.value), { concurrency: "unbounded" }),
    Stream.filter(Option.isSome),
    Stream.map((reply) => reply.value),
    Stream.map((reply) => `${encodeLine(reply)}\n`),
    Stream.encodeText,
    Stream.run(stdio.stdout()),
  );
});
