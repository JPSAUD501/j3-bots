// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A long name's suffix is a synchronous SHA-256, which only node:crypto gives a pure function.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

/**
 * The names a bot sees for connector tools. They reach the bot through the
 * `j3` MCP server, so a harness shows them as `mcp__j3__<name>`. Claude Code
 * takes tool names of at most 64 characters from `[A-Za-z0-9_-]`, which
 * leaves {@link MAX_TOOL_NAME} for the name; Codex takes 128.
 *
 * A name is `<connector slug>__<tool>`. J3 Bots' own tool names never hold
 * `__`, so no connector tool can pose as one of them.
 */

/** What is left of Claude Code's 64 characters after `mcp__j3__`. */
export const MAX_TOOL_NAME = 55;

/**
 * A connector's short name in its tools' names: lowercase letters, digits and
 * single hyphens, at most 20 characters. The server keeps it unique.
 */
export const ConnectorSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:-?[a-z0-9]){0,19}$/),
  Schema.isMaxLength(20),
).pipe(Schema.brand("ConnectorSlug"));
export type ConnectorSlug = typeof ConnectorSlug.Type;

const SEPARATOR = "__";
const SUFFIX_LENGTH = 8;
const ALLOWED = /^[A-Za-z0-9_-]+$/;

/**
 * The name a bot calls `tool` of the connector `slug` by. A tool name with
 * other characters, or too long to fit, is cut and given a suffix from a hash
 * of its full name, so the result depends only on the two names.
 */
export const toolName = (slug: ConnectorSlug, tool: string): string => {
  const plain = `${slug}${SEPARATOR}${tool}`;
  // A leading `_` would run into the separator and make a second `__`.
  if (
    ALLOWED.test(tool) &&
    !tool.startsWith("_") &&
    !tool.includes(SEPARATOR) &&
    plain.length <= MAX_TOOL_NAME
  ) {
    return plain;
  }
  const suffix = NodeCrypto.createHash("sha256")
    .update(tool, "utf8")
    .digest("hex")
    .slice(0, SUFFIX_LENGTH);
  const room = MAX_TOOL_NAME - slug.length - SEPARATOR.length - 1 - SUFFIX_LENGTH;
  const kept = tool
    .replace(/[^A-Za-z0-9-]+/g, "_")
    .slice(0, room)
    .replace(/^_+|_+$/g, "");
  return kept === "" ? `${slug}${SEPARATOR}${suffix}` : `${slug}${SEPARATOR}${kept}_${suffix}`;
};

const SLUG_LENGTH = 20;

/**
 * The slug for a connector named `name`, apart from every slug in `taken`:
 * its name in lowercase letters and digits joined by single hyphens, and
 * `-2`, `-3` and so on after it while that one is taken.
 */
export const slugFor = (name: string, taken: ReadonlySet<string>): ConnectorSlug => {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = words === "" ? "connector" : words;
  const fit = (text: string, room: number) => text.slice(0, room).replace(/-+$/, "");
  let slug = fit(base, SLUG_LENGTH);
  for (let n = 2; taken.has(slug); n++) {
    const suffix = `-${n}`;
    slug = `${fit(base, SLUG_LENGTH - suffix.length)}${suffix}`;
  }
  return ConnectorSlug.make(slug);
};
