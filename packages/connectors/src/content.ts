// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * MCP content as J3 Bots reads it: a tool's answer, a prompt's message, a
 * resource's contents. Decoded at the boundary; text is kept, and anything
 * binary is named by its type and address, never inlined.
 */

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Media = Schema.Struct({
  type: Schema.Literals(["image", "audio"]),
  mimeType: Schema.String,
});
const Link = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
});

/** One of a resource's contents: text, or base64 bytes. */
export const ResourceContents = Schema.Union([
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optionalKey(Schema.String),
    text: Schema.String,
    _meta: Schema.optionalKey(Schema.JsonObject),
  }),
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optionalKey(Schema.String),
    blob: Schema.String,
    _meta: Schema.optionalKey(Schema.JsonObject),
  }),
]);
export type ResourceContents = typeof ResourceContents.Type;

const Embedded = Schema.Struct({ type: Schema.Literal("resource"), resource: ResourceContents });

const Block = Schema.Union([Text, Media, Link, Embedded]);
type Block = typeof Block.Type;
const decodeBlock = Schema.decodeUnknownResult(Block);

/** A resource's contents in a line of text: its text, or what it is when binary. */
export const resourceText = (contents: ResourceContents): string =>
  "text" in contents
    ? contents.text
    : `[file: ${contents.mimeType ?? "unknown type"} ${contents.uri}, not shown]`;

const blockText = (block: Block): string => {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
    case "audio":
      return `[${block.type}: ${block.mimeType}, not shown]`;
    case "resource_link":
      return `[link: ${block.name} ${block.uri}]`;
    case "resource":
      return resourceText(block.resource);
  }
};

/** One content block as text; one of a kind J3 Bots does not read is named so. */
export const contentText = (block: unknown): string => {
  const decoded = decodeBlock(block);
  return Result.isSuccess(decoded)
    ? blockText(decoded.success)
    : "[content of a kind J3 Bots does not read]";
};

/** A tool's answer, decoded: its content, whether it is an error, and its structured result. */
export const CallResult = Schema.Struct({
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
export type CallResult = typeof CallResult.Type;

/** A tool's answer as text: its content's, or its structured result as JSON when it has no content. */
export const answerText = (result: CallResult): string => {
  const parts = (result.content ?? []).map(contentText);
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent) ?? "";
  }
  return parts.join("\n\n");
};
