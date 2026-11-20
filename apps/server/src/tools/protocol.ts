// SPDX-License-Identifier: AGPL-3.0-or-later
import { SessionId } from "@j3-bots/engine-t3";
import * as Schema from "effect/Schema";

// What the `j3` bridge and the server's tool endpoint say to each other, over
// loopback HTTP. Both sides are this package, so the shape is private to it.

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
  /** What the tool returns to the bot. */
  Schema.TaggedStruct("result", { value: Schema.Json }),
  /** Why the call did nothing, in words for the bot. */
  Schema.TaggedStruct("refused", { message: Schema.String }),
]);
export type ToolCallResponse = typeof ToolCallResponse.Type;
