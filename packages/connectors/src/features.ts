// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { cleanDescription, cleanText, cleanTitle } from "./catalog.ts";

/**
 * A connector's resources and prompts, as its server lists them, cleaned
 * as its tools are (`catalog.ts`): what a bot or the operator reads of them
 * is remote text, so every text is cleaned and capped, and an entry J3 Bots
 * cannot name safely is left out.
 */

/** The longest resource address or template kept, in characters. */
const MAX_URI = 2_048;
/** The longest prompt argument name, in characters. */
const MAX_ARGUMENT_NAME = 64;
/** The most arguments one prompt takes. */
const MAX_ARGUMENTS = 20;

/** A name as MCP gives prompts: letters, digits and `_`, `-`, `.`, `/`, up to 128. */
const NAME = /^[A-Za-z0-9_./-]{1,128}$/;

const Text = Schema.optionalKey(Schema.String);

const ListedResource = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  title: Text,
  description: Text,
  mimeType: Text,
  size: Schema.optionalKey(Schema.Finite),
});

const ListedTemplate = Schema.Struct({
  uriTemplate: Schema.String,
  name: Schema.String,
  title: Text,
  description: Text,
  mimeType: Text,
});

const ListedPrompt = Schema.Struct({
  name: Schema.String,
  title: Text,
  description: Text,
  arguments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        title: Text,
        description: Text,
        required: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});

/** A resource a server offers to be read: by its address, or by a template's. */
export interface Resource {
  readonly kind: "resource" | "template";
  /** Its address, or for a template the address with `{placeholders}` (RFC 6570). */
  readonly uri: string;
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly mimeType: string | null;
}

export interface PromptArgument {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly required: boolean;
}

/** A prompt a server offers: a message it writes from the arguments it is given. */
export interface Prompt {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly arguments: ReadonlyArray<PromptArgument>;
}

const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

/** A remote address kept only as it is, when cleaning would not change it. */
const cleanUri = (uri: string): string | null =>
  uri.length > 0 && uri.length <= MAX_URI && cleanText(uri) === uri && !/\s/u.test(uri)
    ? uri
    : null;

/** What decodes of `items`; the rest is left out. */
const decoded =
  <A>(decode: (item: unknown) => Result.Result<A, unknown>) =>
  (items: ReadonlyArray<unknown>): ReadonlyArray<A> =>
    items.flatMap((item) => {
      const result = decode(item);
      return Result.isSuccess(result) ? [result.success] : [];
    });

const decodeResources = decoded(Schema.decodeUnknownResult(ListedResource));
const decodeTemplates = decoded(Schema.decodeUnknownResult(ListedTemplate));
const decodePrompts = decoded(Schema.decodeUnknownResult(ListedPrompt));

const nameOf = (name: string): string | null => {
  const cleaned = cleanTitle(name);
  return cleaned === null || cleaned !== name ? null : cleaned;
};

/** The resources and templates of a listing that J3 Bots can name, cleaned, the first of any repeated address kept. */
export const resourcesOf = (
  resources: ReadonlyArray<unknown>,
  templates: ReadonlyArray<unknown>,
  redact: (text: string) => string,
): ReadonlyArray<Resource> => {
  const out: Array<Resource> = [];
  const seen = new Set<string>();
  const add = (
    kind: Resource["kind"],
    raw: { name: string; title?: string; description?: string; mimeType?: string },
    address: string,
  ) => {
    const uri = cleanUri(address);
    const name = nameOf(raw.name);
    if (uri === null || name === null || seen.has(uri) || redact(uri) !== uri) return;
    seen.add(uri);
    out.push({
      kind,
      uri,
      name,
      title: cleanTitle(raw.title === undefined ? undefined : redact(raw.title)),
      description: cleanDescription(redact(raw.description ?? "")),
      mimeType: raw.mimeType !== undefined && MIME.test(raw.mimeType) ? raw.mimeType : null,
    });
  };
  for (const resource of decodeResources(resources)) add("resource", resource, resource.uri);
  for (const template of decodeTemplates(templates))
    add("template", template, template.uriTemplate);
  return out;
};

/** The prompts of a listing that J3 Bots can name, cleaned, the first of any repeated name kept. */
export const promptsOf = (
  prompts: ReadonlyArray<unknown>,
  redact: (text: string) => string,
): ReadonlyArray<Prompt> => {
  const out: Array<Prompt> = [];
  const seen = new Set<string>();
  for (const prompt of decodePrompts(prompts)) {
    if (!NAME.test(prompt.name) || seen.has(prompt.name)) continue;
    const args = prompt.arguments ?? [];
    if (args.length > MAX_ARGUMENTS) continue;
    const argumentNames = new Set<string>();
    const cleanArgs: Array<PromptArgument> = [];
    for (const arg of args) {
      if (!/^[A-Za-z0-9_.-]+$/u.test(arg.name) || arg.name.length > MAX_ARGUMENT_NAME) break;
      if (argumentNames.has(arg.name)) break;
      argumentNames.add(arg.name);
      cleanArgs.push({
        name: arg.name,
        title: cleanTitle(arg.title === undefined ? undefined : redact(arg.title)),
        description: cleanDescription(redact(arg.description ?? "")),
        required: arg.required === true,
      });
    }
    // An argument J3 Bots cannot name leaves the prompt out: it could not be given in full.
    if (cleanArgs.length !== args.length) continue;
    seen.add(prompt.name);
    out.push({
      name: prompt.name,
      title: cleanTitle(prompt.title === undefined ? undefined : redact(prompt.title)),
      description: cleanDescription(redact(prompt.description ?? "")),
      arguments: cleanArgs,
    });
  }
  return out;
};

/** About how many bytes a resource or prompt takes to keep: what a listing's budget counts. */
export const entryBytes = (entry: Resource | Prompt): number =>
  Buffer.byteLength(JSON.stringify(entry), "utf8");
