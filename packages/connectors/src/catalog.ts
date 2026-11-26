// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A tool's digest is a synchronous SHA-256, which only node:crypto gives a pure function.
import * as NodeCrypto from "node:crypto";
import { defuseTags } from "@j3-bots/prompts";
import * as Schema from "effect/Schema";
import { codePointsEnd } from "./text.ts";

/**
 * A connector's tool catalog (`docs/architecture/server.md`, "Connectors"):
 * what its server lists, cleaned into what a bot is offered.
 *
 * A tool's description and input schema are text the model reads, written by
 * the remote server, so both are prompt-injection vectors. Each is cleaned
 * and capped here, and a bot reads it after J3 Bots' own line saying whose it
 * is; a server that changes its tools changes what bots are offered as it
 * serves them (decision 0047).
 */

/** The longest description a bot reads, in characters. */
export const MAX_DESCRIPTION_CHARACTERS = 1_024;

/** The longest title the operator reads, in characters: a label's. */
const MAX_TITLE_CHARACTERS = 200;

/** The largest input schema offered, as JSON. A larger one is a cost and a hiding place. */
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** A tool name as MCP allows it (2025-11-25 and 2026-07-28): 1 to 128 of letters, digits, `_`, `-` and `.`. */
const UPSTREAM_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** A tool as its server listed it: decoded at the boundary, with nothing else kept. */
export const ListedTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.JsonObject,
  _meta: Schema.optionalKey(Schema.Struct({ ui: Schema.optionalKey(Schema.JsonObject) })),
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
  /**
   * What the tool's `_meta.ui` says, as its server wrote it, for the MCP Apps
   * extension: the `ui://` resource that renders its calls and who may call
   * it. No model reads it. Null when it has none.
   */
  ui: Schema.NullOr(Schema.JsonObject),
  /** SHA-256 of the title, description, input schema and `ui`: whether what bots are offered changed. */
  digest: Schema.String,
});
export type CatalogTool = typeof CatalogTool.Type;

/** Characters that change how text reads without being seen: controls (apart from line breaks and tabs), format and private-use characters. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
const KEPT_CONTROLS = new Set(["\n", "\t"]);

/** Remote text as a model or the operator reads it: no hidden characters, and no J3 Bots tags. */
export const cleanText = (text: string): string =>
  defuseTags(text.replace(UNSEEN, (char) => (KEPT_CONTROLS.has(char) ? char : "")));

/** A remote description as a bot reads it: cleaned, at most {@link MAX_DESCRIPTION_CHARACTERS}. */
export const cleanDescription = (text: string): string =>
  cap(cleanText(text).trim(), MAX_DESCRIPTION_CHARACTERS);

/** `text` at most `max` characters, ending in `…` when cut. */
export const cap = (text: string, max: number) => {
  const end = codePointsEnd(text, max - 1);
  return end === null || codePointsEnd(text, max) === null ? text : `${text.slice(0, end)}…`;
};

/** A remote title as the operator reads it: one line, cleaned, at most {@link MAX_TITLE_CHARACTERS}; null when empty. */
export const cleanTitle = (text: string | undefined): string | null => {
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
    // A page's address that holds a secret would point nowhere once cleaned: none is kept.
    const listedUi = tool._meta?.ui ?? null;
    const ui =
      listedUi !== null && redact(canonical(listedUi)) !== canonical(listedUi) ? null : listedUi;
    tools.push({
      name: tool.name,
      title,
      description,
      inputSchema,
      ui,
      digest: sha256(`${canonical(title)}\n${canonical(description)}\n${schema}\n${canonical(ui)}`),
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
