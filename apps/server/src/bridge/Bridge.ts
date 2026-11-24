// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SessionId } from "@j3-bots/engine-t3";
import { isConnectorTool, toolList } from "@j3-bots/prompts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  CONNECTOR_CALL_DEADLINE,
  type ListedTool,
  TOOL_CALL_PATH,
  TOOL_CHANGES_PATH,
  TOOL_LIST_PATH,
  ToolCallRequest,
  ToolCallResponse,
  ToolChangesRequest,
  ToolChangesResponse,
  ToolListRequest,
  ToolListResponse,
} from "../tools/protocol.ts";

/** The MCP revision answered when the client names none. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** How long a call to one of J3 Bots' own tools keeps trying to reach the server before it gives up. */
const FORWARD_DEADLINE = Duration.seconds(30);

/** How long the bridge waits before it forwards a request again, after the server could not be reached. */
export const FORWARD_RETRY_PAUSE = Duration.millis(250);

/** How long listing the session's tools may take before the bridge lists J3 Bots' own. */
const LIST_DEADLINE = Duration.seconds(10);

/** Past the server's own wait for a change, which answers first. */
const CHANGES_DEADLINE = Duration.minutes(5);

/**
 * The version of a list the bridge made without the server: no server gives
 * it, so the first change the server reports makes the harness list again.
 */
const UNLISTED = "";

const RpcId = Schema.Union([Schema.String, Schema.Number]);
type RpcId = typeof RpcId.Type;

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
const Cancelled = Schema.Struct({ requestId: RpcId });

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeOption = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownOption(schema);

const textResult = (text: string, isError: boolean): Schema.Json => ({
  content: [{ type: "text", text }],
  isError,
});

/** J3 Bots' own tools: what a bridge lists when the server gives it nothing else. */
const ownTools: ReadonlyArray<ListedTool> = toolList.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: decodeOption(Schema.Json)(tool.inputSchema).pipe(
    Option.getOrElse((): Schema.Json => ({ type: "object" })),
  ),
}));

/** A request's id as the key of its fiber: `1` and `"1"` are different requests. */
const keyOf = (id: RpcId) => `${typeof id}:${id}`;

/**
 * The `j3` MCP server a harness starts for every session: a stdio process that
 * lists the session's tools and forwards each call to the J3 Bots server's
 * tool endpoint on loopback. It keeps nothing and does nothing of its own
 * (`docs/architecture/server.md`, Bot tools). The list is J3 Bots' own tools
 * and the connector tools the session's bot is offered; when that changes,
 * the bridge tells the harness to list again. A forward keeps one id across
 * its retries, so the server acts on a call once however often it arrives,
 * and a call the harness cancels, or leaves running when it closes the
 * bridge's input, is abandoned at the server.
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
  const once = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const client = once.pipe(
    HttpClient.retryTransient({
      // Until the request's deadline, which ends the retries.
      schedule: Schedule.spaced(FORWARD_RETRY_PAUSE),
    }),
  );

  const post = <S extends Schema.Constraint, T extends Schema.Decoder<unknown>>(
    path: string,
    request: S,
    response: T,
    client: HttpClient.HttpClient,
  ) =>
    Effect.fn("Bridge.post")(function* (body: S["Type"]) {
      const outgoing = yield* HttpClientRequest.post(`${options.server}${path}`).pipe(
        HttpClientRequest.schemaBodyJson(request)(body),
      );
      return yield* HttpClientResponse.schemaBodyJson(response)(yield* client.execute(outgoing));
    });
  const forward = post(TOOL_CALL_PATH, ToolCallRequest, ToolCallResponse, client);
  const fetchList = post(TOOL_LIST_PATH, ToolListRequest, ToolListResponse, client);
  // Sent once: a wait the server does not answer means it is gone, or does
  // not know the session.
  const fetchChange = post(TOOL_CHANGES_PATH, ToolChangesRequest, ToolChangesResponse, once);

  const output = yield* Queue.unbounded<string, Cause.Done>();
  const send = (message: Schema.Json) => Queue.offer(output, `${encodeLine(message)}\n`);
  /** The requests being answered, by id, so a cancelled one can be interrupted. */
  const requests = yield* FiberMap.make<string, void, never>();
  /** The version of the list the harness was last given. */
  const listed = yield* Ref.make(UNLISTED);
  /** Done once the harness has listed the tools: before that, no change is news to it. */
  const firstListed = yield* Deferred.make<void>();

  const listTools = Effect.fn("Bridge.listTools")(function* () {
    if (Option.isNone(options.session)) return ownTools;
    const list = yield* fetchList({ sessionId: options.session.value }).pipe(
      Effect.timeout(LIST_DEADLINE),
      Effect.option,
    );
    yield* Ref.set(
      listed,
      Option.match(list, { onNone: () => UNLISTED, onSome: (l) => l.version }),
    );
    yield* Deferred.succeed(firstListed, undefined);
    return Option.match(list, { onNone: () => ownTools, onSome: (l) => l.tools });
  });

  /**
   * Waits on the server for the session's list to change, and tells the
   * harness to list again when it has. Starts once the harness has listed
   * the tools, and stops at the first wait the server does not answer: it is
   * stopping, and its harnesses with it, or the session is no bot's. So an
   * idle bridge never sends its session's id to a port the server has let go.
   */
  const watchChanges = Effect.fn("Bridge.watchChanges")(function* (sessionId: SessionId) {
    yield* Deferred.await(firstListed);
    while (true) {
      const since = yield* Ref.get(listed);
      const change = yield* fetchChange({ sessionId, since }).pipe(
        Effect.timeout(CHANGES_DEADLINE),
        Effect.option,
      );
      if (Option.isNone(change)) return;
      // The harness may have listed this version meanwhile.
      if (change.value.version === (yield* Ref.get(listed))) continue;
      yield* Ref.set(listed, change.value.version);
      yield* send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  });

  const callTool = Effect.fn("Bridge.callTool")(function* (params: Schema.Json | undefined) {
    const call = decodeOption(ToolCall)(params);
    if (Option.isNone(call)) return textResult("The call names no tool.", true);
    if (Option.isNone(options.session)) {
      return textResult("This bridge was not started by a J3 Bots session.", true);
    }
    const connector = isConnectorTool(call.value.name);
    const requestId = Base64Url.encode(yield* random.randomBytes(16));
    const answer = yield* forward({
      requestId,
      sessionId: options.session.value,
      tool: call.value.name,
      arguments: call.value.arguments ?? {},
    }).pipe(Effect.timeout(connector ? CONNECTOR_CALL_DEADLINE : FORWARD_DEADLINE), Effect.option);
    if (Option.isNone(answer)) {
      // The server may have made a connector's call before its answer was
      // lost, and a new call is a new request: the bot is told to look first.
      return textResult(
        connector
          ? "J3 Bots did not answer this call, so it may or may not have taken effect at the connector. Check before you make it again."
          : "J3 Bots could not be reached. Try the call again.",
        true,
      );
    }
    switch (answer.value._tag) {
      case "result":
        return textResult(encodeLine(answer.value.value), false);
      case "text":
        return textResult(answer.value.text, answer.value.isError);
      case "refused":
        return textResult(answer.value.message, true);
    }
  });

  /** The answer to one request. */
  const answer = Effect.fn("Bridge.answer")(function* (id: RpcId, message: Incoming) {
    const respond = (result: Schema.Json): Schema.Json => ({ jsonrpc: "2.0", id, result });
    switch (message.method) {
      case "initialize": {
        const requested = decodeOption(Initialize)(message.params);
        return respond({
          protocolVersion: Option.match(requested, {
            onNone: () => DEFAULT_PROTOCOL_VERSION,
            onSome: (params) => params.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          }),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "j3", version: options.version },
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: [...(yield* listTools())] });
      case "tools/call":
        return respond(yield* callTool(message.params));
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        } satisfies Schema.Json;
    }
  });

  /** A notification: only a cancelled request is acted on, and gets no answer. */
  const notified = Effect.fn("Bridge.notified")(function* (message: Incoming) {
    if (message.method !== "notifications/cancelled") return;
    const cancelled = decodeOption(Cancelled)(message.params);
    if (Option.isSome(cancelled)) {
      yield* FiberMap.remove(requests, keyOf(cancelled.value.requestId));
    }
  });

  const received = Effect.fn("Bridge.received")(function* (message: Incoming) {
    const id = message.id;
    if (id === undefined) return yield* notified(message);
    yield* FiberMap.run(requests, keyOf(id), Effect.flatMap(answer(id, message), send), {
      onlyIfMissing: true,
    });
  });

  const writer = yield* Stream.fromQueue(output).pipe(
    Stream.encodeText,
    Stream.run(stdio.stdout()),
    Effect.forkScoped,
  );
  if (Option.isSome(options.session)) yield* Effect.forkScoped(watchChanges(options.session.value));

  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    // A line that is not a JSON-RPC request or notification gets no answer.
    Stream.map((line) => decodeLine(line)),
    Stream.filter(Option.isSome),
    Stream.runForEach((message) => received(message.value)),
  );
  // The harness closed its end and reads no answer any more: what it asked is
  // abandoned at the server, as a cancelled call is, and the bridge stops.
  yield* FiberMap.clear(requests);
  yield* Queue.end(output);
  yield* Fiber.join(writer);
}, Effect.scoped);
