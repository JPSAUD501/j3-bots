// SPDX-License-Identifier: AGPL-3.0-or-later
import { SessionId } from "@j3-bots/engine-t3";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// What the `j3` bridge and the server's tool endpoint say to each other, over
// loopback HTTP. Both sides are this package, so the shape is private to it.

/**
 * How long the bridge waits for the answer to a connector tool's call: past
 * the connector client's own deadline, so an answer for a call that ran out
 * arrives first. A harness waits a minute longer for the bridge
 * (`ToolBridge.callTimeoutSeconds`).
 */
export const CONNECTOR_CALL_DEADLINE = Duration.minutes(11);

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
