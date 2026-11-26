// SPDX-License-Identifier: AGPL-3.0-or-later
import { SessionId } from "@j3-bots/engine-t3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Mac from "effect/crypto/Mac";

// What the `j3` bridge and the server's tool endpoint say to each other, over
// loopback HTTP. Both sides are this package, so the shape is private to it.

/**
 * The variable the bridge reads its key from: the bytes of an HMAC-SHA256
 * key, in base64url. The server makes a new key each time it starts, and the
 * engine starts every bridge with it (`ToolBridge.environment`).
 */
export const BRIDGE_KEY_VARIABLE = "J3_BRIDGE_KEY";

/**
 * The header that carries a request's tag, and the tag of the answer to it.
 * A request is tagged over its path and its body as sent; an answer over the
 * request's tag and its own body, so it answers that request only.
 */
export const SIGNATURE_HEADER = "x-j3-signature";

const encoder = new TextEncoder();
const requestData = (path: string, body: string) => encoder.encode(`request\n${path}\n${body}`);
const answerData = (requestTag: string, body: string) =>
  encoder.encode(`answer\n${requestTag}\n${body}`);

/** Signs and checks what the bridge and the endpoint send each other, with the key they share. */
export interface BridgeSigner {
  readonly signRequest: (path: string, body: string) => Effect.Effect<string>;
  /** Whether `tag` is the request's, in constant time; a missing or malformed one is not. */
  readonly verifyRequest: (
    path: string,
    body: string,
    tag: string | undefined,
  ) => Effect.Effect<boolean>;
  readonly signAnswer: (requestTag: string, body: string) => Effect.Effect<string>;
  /** Whether `tag` is the answer's to the request tagged `requestTag`, in constant time. */
  readonly verifyAnswer: (
    requestTag: string,
    body: string,
    tag: string | undefined,
  ) => Effect.Effect<boolean>;
}

/** A signer with `key`. HMAC with a valid key cannot fail, so a failure is a defect. */
export const bridgeSigner = Effect.fn("bridgeSigner")(function* (key: Mac.Key) {
  const mac = yield* Mac.Mac;
  const sign = (data: Uint8Array) => mac.sign(key, data).pipe(Effect.map(Base64Url.encode));
  const verify = (data: Uint8Array, tag: string | undefined) => {
    const bytes = tag === undefined ? undefined : Result.getOrUndefined(Base64Url.decode(tag));
    return bytes === undefined ? Effect.succeed(false) : mac.verify(key, bytes, data);
  };
  return {
    signRequest: (path, body) => Effect.orDie(sign(requestData(path, body))),
    verifyRequest: (path, body, tag) => Effect.orDie(verify(requestData(path, body), tag)),
    signAnswer: (requestTag, body) => Effect.orDie(sign(answerData(requestTag, body))),
    verifyAnswer: (requestTag, body, tag) =>
      Effect.orDie(verify(answerData(requestTag, body), tag)),
  } satisfies BridgeSigner;
});

/** The key a bridge was started with, from its text; none when the text is not one. */
export const bridgeKeyOf = (text: string) =>
  Option.match(Result.getSuccess(Base64Url.decode(text)), {
    onNone: () => Effect.succeedNone,
    onSome: (bytes) => Mac.key(Mac.hmacSha256, bytes).pipe(Effect.option),
  });

/**
 * How long the bridge waits for the answer to a connector tool's call: past
 * the longest the connector client lets one run, which is a call its server
 * runs as a task (`SessionLimits.taskDeadline`, an hour), so an answer for a
 * call that ran out arrives first. A call its server answers at once is cut
 * off by the client well before (`SessionLimits.callDeadline`). A harness
 * waits a minute longer for the bridge (`ToolBridge.callTimeoutSeconds`).
 */
export const CONNECTOR_CALL_DEADLINE = Duration.minutes(61);

/** Where the bridge forwards a call: `POST` a `ToolCallRequest`, answered with a `ToolCallResponse`. */
export const TOOL_CALL_PATH = "/tools/call";

export const ToolCallRequest = Schema.Struct({
  /**
   * The bridge's id for the call, the same on every retry of its forward, so a
   * retry returns the first result instead of acting twice.
   */
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  /** The engine session that started the bridge. */
  sessionId: SessionId,
  tool: Schema.String,
  arguments: Schema.Json,
});
export type ToolCallRequest = typeof ToolCallRequest.Type;

export const ToolCallResponse = Schema.Union([
  /** What one of J3 Bots' own tools returns to the bot. */
  Schema.TaggedStruct("result", { value: Schema.Json }),
  /** What a connector's tool returns, already framed for the bot. */
  Schema.TaggedStruct("text", { text: Schema.String, isError: Schema.Boolean }),
  /** Why the call did nothing, in words for the bot. */
  Schema.TaggedStruct("refused", { message: Schema.String }),
]);
export type ToolCallResponse = typeof ToolCallResponse.Type;

/**
 * Where the bridge lists its session's tools: `POST` a `ToolListRequest`,
 * answered with a `ToolListResponse`.
 */
export const TOOL_LIST_PATH = "/tools/list";

/**
 * Where the bridge waits for its session's tools to change: `POST` a
 * `ToolChangesRequest`, answered with a `ToolChangesResponse` once the list's
 * version is not `since`, or with the same version when the wait ran out.
 */
export const TOOL_CHANGES_PATH = "/tools/changes";

export const ToolListRequest = Schema.Struct({ sessionId: SessionId });
export type ToolListRequest = typeof ToolListRequest.Type;

/** A tool as MCP's `tools/list` describes it. */
export const ListedTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Json,
  /** For J3 Bots' own tools, what keeps them loaded when the harness defers MCP tools. */
  _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type ListedTool = typeof ListedTool.Type;

export const ToolListResponse = Schema.Struct({
  /** Changes whenever the list may have: another for each change, and another for each server process. */
  version: Schema.String,
  tools: Schema.Array(ListedTool),
});
export type ToolListResponse = typeof ToolListResponse.Type;

export const ToolChangesRequest = Schema.Struct({ sessionId: SessionId, since: Schema.String });
export type ToolChangesRequest = typeof ToolChangesRequest.Type;

export const ToolChangesResponse = Schema.Struct({ version: Schema.String });
export type ToolChangesResponse = typeof ToolChangesResponse.Type;
