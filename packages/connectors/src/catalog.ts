// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A tool's digest is a synchronous SHA-256, which only node:crypto gives a pure function.
import * as NodeCrypto from "node:crypto";
import { defuseTags } from "@j3-bots/prompts";
import * as Schema from "effect/Schema";
import { codePointsEnd } from "./text.ts";

/**
 * A connector's tool catalog (`docs/architecture/server.md`, "Connectors"):
 * what its server lists, what the operator consented to, and what a bot is
 * offered.
 *
 * A tool's description and input schema are text the model reads, written by
 * the remote server, so both are prompt-injection vectors, and a server can
 * change them at any time after the operator connected it. J3 Bots keeps the
 * tools as they were when the operator connected the connector (the accepted
 * catalog) and offers a bot only a tool whose listing still matches. A new
 * tool, or a tool whose description or schema changed, is held until the
 * operator accepts the change; a removed tool goes at once.
 */

/** The longest description a bot reads, in characters. */
export const MAX_DESCRIPTION_CHARACTERS = 1_024;

/** The longest title the operator reads, in characters: a label's. */
const MAX_TITLE_CHARACTERS = 200;

/** The largest input schema offered, as JSON. A larger one is a cost and a hiding place. */
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** A tool name as MCP allows it (2025-11-25): 1 to 128 of letters, digits, `_`, `-` and `.`. */
const UPSTREAM_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** A tool as its server listed it: decoded at the boundary, with nothing else kept. */
export const ListedTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.JsonObject,
});
export type ListedTool = typeof ListedTool.Type;

/** A tool as J3 Bots keeps and offers it. */
export const CatalogTool = Schema.Struct({
  /** Its name at its server, which a call uses. */
  name: Schema.String,
  /** Cleaned, on one line, at most {@link MAX_TITLE_CHARACTERS}; null when it has none. */
  title: Schema.NullOr(Schema.String),
  /** Cleaned and capped: what a bot reads. */
  description: Schema.String,
  inputSchema: Schema.JsonObject,
  /** SHA-256 of the input schema alone, which says whether what the tool takes changed. */
  inputDigest: Schema.String,
  /** SHA-256 of the title, description and input schema, as the operator reviewed them. */
  digest: Schema.String,
});
export type CatalogTool = typeof CatalogTool.Type;

/** Characters that change how text reads without being seen: controls (apart from line breaks and tabs), format and private-use characters. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
const KEPT_CONTROLS = new Set(["\n", "\t"]);

/** Remote text as a model reads it: no hidden characters, and no J3 Bots tags. */
const cleanText = (text: string): string =>
  defuseTags(text.replace(UNSEEN, (char) => (KEPT_CONTROLS.has(char) ? char : "")));

/** A remote description as a bot reads it: cleaned, at most {@link MAX_DESCRIPTION_CHARACTERS}. */
const cleanDescription = (text: string): string =>
  cap(cleanText(text).trim(), MAX_DESCRIPTION_CHARACTERS);

const cap = (text: string, max: number) => {
  const end = codePointsEnd(text, max - 1);
  return end === null || codePointsEnd(text, max) === null ? text : `${text.slice(0, end)}…`;
};

/** A remote title as the operator reads it: one line, cleaned, at most {@link MAX_TITLE_CHARACTERS}; null when empty. */
const cleanTitle = (text: string | undefined): string | null => {
  const line = cleanDescription(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return line === "" ? null : cap(line, MAX_TITLE_CHARACTERS);
};

/** JSON with every object's keys in order, so equal values have one text. */
const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value);

const canonical = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key] ?? null)}`).join(",")}}`;
};

/**
 * An input schema with every string in it cleaned as a description is, since
 * a model reads those too; undefined when cleaning would change a key, which
 * a call names its arguments by.
 */
const cleanObject = (
  object: Schema.JsonObject,
  clean: (text: string) => string,
): Schema.JsonObject | undefined => {
  const out: Record<string, Schema.Json> = {};
  for (const [key, value] of Object.entries(object)) {
    if (clean(key) !== key) return undefined;
    const cleaned = cleanJson(value, clean);
    if (cleaned === undefined) return undefined;
    out[key] = cleaned;
  }
  return out;
};

const cleanJson = (
  value: Schema.Json,
  clean: (text: string) => string,
): Schema.Json | undefined => {
  if (typeof value === "string") return clean(value);
  // A number can be a secret too, as a key of digits: one cleaning would change leaves the tool out.
  if (typeof value === "number") return clean(String(value)) === String(value) ? value : undefined;
  if (value === null || typeof value !== "object") return value;
  if (!isJsonArray(value)) return cleanObject(value, clean);
  const out: Array<Schema.Json> = [];
  for (const item of value) {
    const cleaned = cleanJson(item, clean);
    if (cleaned === undefined) return undefined;
    out.push(cleaned);
  }
  return out;
};

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

export interface CatalogOptions {
  /** Tools kept from the listing's earlier pages: a name among them is left out. */
  readonly earlier?: ReadonlyArray<CatalogTool>;
  /**
   * Takes values that must not be shown out of remote text (the connector's
   * own secrets, should its server echo them), before it is cleaned. A tool
   * whose name or schema keys it would change is left out.
   */
  readonly redact?: (text: string) => string;
}

/**
 * The tools of a listing that J3 Bots can offer, cleaned, after `earlier`: a
 * valid name, an object input schema within {@link MAX_SCHEMA_BYTES}, and the
 * first of any repeated name. The rest are left out.
 */
export const catalogOf = (
  listed: ReadonlyArray<ListedTool>,
  options: CatalogOptions = {},
): ReadonlyArray<CatalogTool> => {
  const redact = options.redact ?? ((text: string) => text);
  const tools: Array<CatalogTool> = [...(options.earlier ?? [])];
  const seen = new Set(tools.map((tool) => tool.name));
  for (const tool of listed) {
    if (!UPSTREAM_NAME.test(tool.name) || seen.has(tool.name)) continue;
    if (redact(tool.name) !== tool.name) continue;
    const inputSchema = cleanObject(tool.inputSchema, (text) => cleanText(redact(text)));
    if (inputSchema === undefined || inputSchema["type"] !== "object") continue;
    const schema = canonical(inputSchema);
    if (Buffer.byteLength(schema, "utf8") > MAX_SCHEMA_BYTES) continue;
    seen.add(tool.name);
    const title = cleanTitle(tool.title === undefined ? undefined : redact(tool.title));
    const description = cleanDescription(redact(tool.description ?? ""));
    tools.push({
      name: tool.name,
      title,
      description,
      inputSchema,
      inputDigest: sha256(schema),
      digest: sha256(`${canonical(title)}\n${canonical(description)}\n${schema}`),
    });
  }
  return tools;
};

/** About how many bytes a tool takes to keep: what a listing's budget counts. */
export const toolBytes = (tool: CatalogTool): number =>
  Buffer.byteLength(
    `${tool.name}${tool.title ?? ""}${tool.description}${canonical(tool.inputSchema)}`,
    "utf8",
  );

/** A change to a connector's tools that waits for the operator. */
export type HeldChange =
  | { readonly change: "added"; readonly tool: CatalogTool }
  | {
      readonly change: "changed";
      readonly tool: CatalogTool;
      readonly previous: CatalogTool;
      /** What the tool takes changed, whatever its words say. */
      readonly inputChanged: boolean;
    };

export interface CatalogState {
  /** What a bot is offered: accepted tools whose listing still matches. */
  readonly offered: ReadonlyArray<CatalogTool>;
  /** New and changed tools, which no bot is offered until the operator accepts them. */
  readonly held: ReadonlyArray<HeldChange>;
  /**
   * The held changes' names and digests, hashed: what the operator's answer
   * names, so it never covers a change that arrived after they saw the list.
   * Empty when nothing is held.
   */
  readonly revision: string;
}

/** Compares a listing with the accepted catalog. Removed tools simply aren't offered. */
export const compareCatalog = (
  accepted: ReadonlyArray<CatalogTool>,
  listed: ReadonlyArray<CatalogTool>,
): CatalogState => {
  const byName = new Map(accepted.map((tool) => [tool.name, tool]));
  const offered: Array<CatalogTool> = [];
  const held: Array<HeldChange> = [];
  for (const tool of listed) {
    const previous = byName.get(tool.name);
    if (previous === undefined) held.push({ change: "added", tool });
    else if (previous.digest === tool.digest) offered.push(tool);
    else {
      const inputChanged = previous.inputDigest !== tool.inputDigest;
      held.push({ change: "changed", tool, previous, inputChanged });
    }
  }
  const revision =
    held.length === 0
      ? ""
      : sha256(held.map(({ tool }) => `${tool.name}\n${tool.digest}`).join("\n")).slice(0, 32);
  return { offered, held, revision };
};

/**
 * The operator's answer to the held changes they saw at `revision`:
 * - `accept`: the accepted catalog becomes the tools as they are listed now;
 * - `keep`: the accepted catalog stays as it was, and the review closes
 *   until the tools change again (the answered revision is remembered as
 *   `kept`).
 *
 * `null` when the changes held now are not the ones they saw, or none are.
 * Tools the server no longer lists drop out of the accepted catalog.
 */
export const answerChanges = (
  accepted: ReadonlyArray<CatalogTool>,
  listed: ReadonlyArray<CatalogTool>,
  revision: string,
  decision: "accept" | "keep",
): { readonly accepted: ReadonlyArray<CatalogTool>; readonly kept: string | null } | null => {
  const state = compareCatalog(accepted, listed);
  if (state.revision === "" || state.revision !== revision) return null;
  return decision === "accept"
    ? { accepted: [...state.offered, ...state.held.map(({ tool }) => tool)], kept: null }
    : {
        // A changed tool keeps the version the operator accepted, so it is offered again if its server goes back to it.
        accepted: accepted.filter((tool) => listed.some((now) => now.name === tool.name)),
        kept: revision,
      };
};
