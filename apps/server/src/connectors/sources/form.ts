// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type { ConnectorField } from "@j3-bots/contracts";
import { FieldKey, MAX_FIELD_CHOICES } from "@j3-bots/contracts";
import type { Header, Input, Remote } from "./serverJson.ts";

// A remote, as a registry entry or a curated one describes it, mapped to the
// fields of the form the operator fills to connect it, and the filled form
// back to the address and headers J3 Bots sends.
//
// A remote's URL and header values are templates: `{name}` stands for a
// variable. Each variable, and each header with no fixed value, becomes one
// field. A secret header (`isSecret`) or a secret variable becomes a masked
// field, and its value never leaves `Redacted`.

/** The longest description of a field kept from a publisher's text. */
const MAX_FIELD_DESCRIPTION = 300;

/** The longest default, choice or placeholder kept. */
const MAX_FIELD_TEXT = 200;

/** The most fields one remote may ask for; a remote that asks for more is not offered. */
const MAX_FIELDS = 16;

/** The most headers one remote may send. */
const MAX_HEADERS = 16;

/** The longest value the operator may give a field, a token included. */
const MAX_FIELD_VALUE = 4096;

/** The longest header name. */
const MAX_HEADER_NAME = 64;

/** A header name as HTTP writes it: one token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers the transport sets itself, or that would change where or how the
 * request goes. A remote that asks to set one is not offered.
 */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** `{name}` in a template. A brace around anything else is literal text. */
const PLACEHOLDER = /\{([A-Za-z0-9_.-]{1,64})\}/g;

/** Control characters: never part of a header value or a URL. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Where a field's value goes. */
type FieldTarget =
  | { readonly _tag: "url-variable"; readonly variable: string }
  | { readonly _tag: "header"; readonly header: string }
  | { readonly _tag: "header-variable"; readonly header: string; readonly variable: string };

/** One field of the connect form. */
interface ConnectField {
  /** Unique within its form: what the filled form gives the field's value under. */
  readonly key: string;
  readonly target: FieldTarget;
  /** The variable's or the header's name, as published. */
  readonly name: string;
  /** The publisher's description, capped. Untrusted text, shown as text. */
  readonly description: string | null;
  /** A masked field: a token, a key, a password. */
  readonly secret: boolean;
  /** The form is refused without it, unless it has a default. */
  readonly required: boolean;
  readonly default: string | null;
  /** When not empty, the value must be one of these. */
  readonly choices: ReadonlyArray<string>;
  readonly placeholder: string | null;
}

type Part =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "field"; readonly key: string };

/** A template, split into fixed text and fields. */
type Template = ReadonlyArray<Part>;

/** A remote J3 Bots can connect, and the form that connects it. */
export interface ConnectForm {
  /** The URL as published, braces and all. */
  readonly urlTemplate: string;
  readonly url: Template;
  /** In the order published. A header whose fields are all left empty is not sent. */
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: Template }>;
  readonly fields: ReadonlyArray<ConnectField>;
}

/** Why a remote is not offered. Kept for tests and diagnostics; never shown with a value. */
type Unusable =
  | "not-streamable-http"
  | "not-https"
  | "bad-header"
  | "reserved-header"
  | "too-many-fields"
  | "control-character";

const fieldKey = (target: FieldTarget) => {
  switch (target._tag) {
    case "url-variable":
      return `url:${target.variable}`;
    case "header":
      return `header:${target.header}`;
    case "header-variable":
      return `header:${target.header}:${target.variable}`;
  }
};

/**
 * Publisher text made safe to show as one paragraph: control and format
 * characters (such as those that reverse the text's direction) and runs of
 * white space become one space, and text longer than `max` UTF-16
 * units, which is how the contract's limits count, is cut at a character's
 * boundary and ends with an ellipsis. `null` for none.
 */
export const plainText = (text: string | undefined, max: number): string | null => {
  if (text === undefined) return null;
  const plain = text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
  if (plain === "") return null;
  if (plain.length <= max) return plain;
  let cut = "";
  for (const character of plain) {
    if (cut.length + character.length > max - 1) break;
    cut += character;
  }
  return `${cut.trimEnd()}…`;
};

/** Control and format characters, such as those that reverse the text's direction. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}]/u;

/**
 * A value the publisher fixed, kept only when it could be sent as it is and
 * shown as it is sent.
 */
const plainValue = (text: string | undefined): string | null =>
  text === undefined || text === "" || UNSHOWABLE.test(text) || text.length > MAX_FIELD_TEXT
    ? null
    : text;

/** The field for one input, under its target. */
const fieldOf = (
  target: FieldTarget,
  name: string,
  input: Input,
  inherited: { readonly secret: boolean; readonly required: boolean },
): ConnectField => {
  const choices = (input.choices ?? [])
    .map(plainValue)
    .filter((choice): choice is string => choice !== null)
    .slice(0, MAX_FIELD_CHOICES);
  const fallback = plainValue(input.default);
  return {
    key: fieldKey(target),
    target,
    name,
    description: plainText(input.description, MAX_FIELD_DESCRIPTION),
    secret: inherited.secret || input.isSecret === true,
    required: inherited.required || input.isRequired === true,
    default:
      fallback !== null && (choices.length === 0 || choices.includes(fallback)) ? fallback : null,
    choices,
    placeholder: plainText(input.placeholder, MAX_FIELD_TEXT),
  };
};

/**
 * A template split into text and fields. Each `{name}` becomes a field: the
 * one `variables` declares, or, when the publisher left it undeclared, one
 * that takes the enclosing value's own description and secrecy. Leaving it in
 * the value as literal braces, as the schema allows, would send a request
 * that cannot work.
 */
const parseTemplate = (
  template: string,
  variables: Readonly<Record<string, Input>> | undefined,
  targetOf: (variable: string) => FieldTarget,
  undeclared: Input,
  inherited: { readonly secret: boolean; readonly required: boolean },
): { readonly parts: Template; readonly fields: ReadonlyArray<ConnectField> } => {
  const parts: Array<Part> = [];
  const fields: Array<ConnectField> = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const [whole, variable] = match;
    if (variable === undefined) continue;
    if (match.index > last) parts.push({ _tag: "text", text: template.slice(last, match.index) });
    last = match.index + whole.length;
    const target = targetOf(variable);
    const key = fieldKey(target);
    parts.push({ _tag: "field", key });
    if (fields.some((field) => field.key === key)) continue;
    const declared =
      variables !== undefined && Object.hasOwn(variables, variable)
        ? variables[variable]
        : undefined;
    fields.push(fieldOf(target, variable, declared ?? undeclared, inherited));
  }
  if (last < template.length) parts.push({ _tag: "text", text: template.slice(last) });
  return { parts, fields };
};

/** The template with every field filled by `fill`. */
const render = (template: Template, fill: (key: string) => string) =>
  template.map((part) => (part._tag === "text" ? part.text : fill(part.key))).join("");

/** Whether a URL template, once filled, is an https address with no user name in it. */
const httpsTemplate = (template: Template) => {
  const sample = render(template, () => "x");
  if (/\s/.test(sample) || !URL.canParse(sample)) return false;
  const url = new URL(sample);
  return url.protocol === "https:" && url.username === "" && url.password === "";
};

const headerForm = (
  header: Header,
): Result.Result<
  { readonly value: Template; readonly fields: ReadonlyArray<ConnectField> },
  Unusable
> => {
  const secret = header.isSecret === true;
  const required = header.isRequired === true;
  if (header.value === undefined || header.value === "") {
    const target: FieldTarget = { _tag: "header", header: header.name };
    return Result.succeed({
      value: [{ _tag: "field", key: fieldKey(target) }],
      fields: [fieldOf(target, header.name, header, { secret, required: false })],
    });
  }
  if (CONTROL.test(header.value)) return Result.fail("control-character");
  const { parts, fields } = parseTemplate(
    header.value,
    header.variables,
    (variable) => ({ _tag: "header-variable", header: header.name, variable }),
    header.description === undefined ? {} : { description: header.description },
    { secret, required },
  );
  return Result.succeed({ value: parts, fields });
};

/**
 * The connect form for `remote`, or why J3 Bots does not offer it. Only
 * Streamable HTTP over https is offered: it is the one transport J3 Bots'
 * connector client speaks.
 */
export const connectForm = (remote: Remote): Result.Result<ConnectForm, Unusable> => {
  if (remote.type !== "streamable-http") return Result.fail("not-streamable-http");
  if (CONTROL.test(remote.url)) return Result.fail("control-character");
  const url = parseTemplate(
    remote.url,
    remote.variables,
    (variable) => ({ _tag: "url-variable", variable }),
    {},
    // A URL cannot have a hole: each of its variables needs a value or a default.
    { secret: false, required: true },
  );
  if (!httpsTemplate(url.parts)) return Result.fail("not-https");
  const published = remote.headers ?? [];
  if (published.length > MAX_HEADERS) return Result.fail("too-many-fields");
  const seen = new Set<string>();
  const headers: Array<ConnectForm["headers"][number]> = [];
  const fields: Array<ConnectField> = [...url.fields];
  for (const header of published) {
    const lower = header.name.toLowerCase();
    if (!HEADER_NAME.test(header.name) || header.name.length > MAX_HEADER_NAME || seen.has(lower)) {
      return Result.fail("bad-header");
    }
    if (RESERVED_HEADERS.has(lower) || lower.startsWith("proxy-"))
      return Result.fail("reserved-header");
    seen.add(lower);
    const form = headerForm(header);
    if (Result.isFailure(form)) return Result.fail(form.failure);
    headers.push({ name: header.name, value: form.success.value });
    fields.push(...form.success.fields);
  }
  if (fields.length > MAX_FIELDS) return Result.fail("too-many-fields");
  return Result.succeed({ urlTemplate: remote.url, url: url.parts, headers, fields });
};

/** What is wrong with one field of a filled form. */
export type FieldProblem =
  | { readonly _tag: "missing"; readonly key: string }
  | { readonly _tag: "not-a-choice"; readonly key: string }
  | { readonly _tag: "invalid"; readonly key: string }
  | { readonly _tag: "unknown"; readonly key: string };

/** A filled form: where to connect and what to send. */
export interface ResolvedRemote {
  /** Redacted: a secret variable may be part of the address. */
  readonly url: Redacted.Redacted<string>;
  /** The address to show: secret variables stay as `{name}`. */
  readonly displayUrl: string;
  readonly headers: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
  }>;
}

/**
 * The address and headers of `form` filled with `values`, keyed by field key,
 * or every problem with them. An empty value counts as none; a field left
 * without one takes its default. A header whose fields all end up without a
 * value is left out, when none of them is required.
 */
/**
 * The values `fields` take from `values`, each one checked, and every
 * problem with them, for a key `values` gives that is not one of `fields` too.
 * An empty value counts as none, and a field left without one takes its
 * default.
 */
const fill = (
  fields: ReadonlyArray<ConnectField>,
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
): {
  readonly filled: ReadonlyMap<string, string>;
  readonly problems: ReadonlyArray<FieldProblem>;
} => {
  const problems: Array<FieldProblem> = [];
  const known = new Set(fields.map((field) => field.key));
  for (const key of values.keys()) if (!known.has(key)) problems.push({ _tag: "unknown", key });
  const filled = new Map<string, string>();
  for (const field of fields) {
    const given = values.get(field.key);
    const value = given === undefined ? "" : Redacted.value(given);
    const chosen = value === "" ? (field.default ?? "") : value;
    if (chosen === "") {
      if (field.required) problems.push({ _tag: "missing", key: field.key });
      continue;
    }
    if (chosen.length > MAX_FIELD_VALUE || CONTROL.test(chosen)) {
      problems.push({ _tag: "invalid", key: field.key });
    } else if (field.choices.length > 0 && !field.choices.includes(chosen)) {
      problems.push({ _tag: "not-a-choice", key: field.key });
    } else {
      filled.set(field.key, chosen);
    }
  }
  return { filled, problems };
};

/** A header's value, rendered from the fields `filled` has. */
const renderHeader = (
  header: ConnectForm["headers"][number],
  filled: ReadonlyMap<string, string>,
) => Redacted.make(render(header.value, (key) => filled.get(key) ?? ""));

/** The keys of a header's fields. */
const keysOf = (header: ConnectForm["headers"][number]) =>
  header.value.flatMap((part) => (part._tag === "field" ? [part.key] : []));

export const resolve = (
  form: ConnectForm,
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
): Result.Result<ResolvedRemote, ReadonlyArray<FieldProblem>> => {
  const { filled, problems: given } = fill(form.fields, values);
  if (given.length > 0) return Result.fail(given);
  const problems: Array<FieldProblem> = [];

  const secret = new Set(form.fields.filter((field) => field.secret).map((field) => field.key));
  const encoded = (key: string) => encodeURIComponent(filled.get(key) ?? "");
  const url = render(form.url, encoded);
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (
    parsed === null ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    const variable = form.url.find((part) => part._tag === "field");
    return Result.fail([
      { _tag: "invalid", key: variable?._tag === "field" ? variable.key : "url" },
    ]);
  }

  const headers: Array<ResolvedRemote["headers"][number]> = [];
  for (const header of form.headers) {
    const keys = keysOf(header);
    if (keys.length > 0 && keys.every((key) => !filled.has(key))) continue;
    const missing = keys.filter((key) => !filled.has(key));
    if (missing.length > 0) {
      problems.push(...missing.map((key): FieldProblem => ({ _tag: "missing", key })));
      continue;
    }
    headers.push({ name: header.name, value: renderHeader(header, filled) });
  }
  if (problems.length > 0) return Result.fail(problems);

  return Result.succeed({
    url: Redacted.make(parsed.href),
    displayUrl: render(form.url, (key) =>
      secret.has(key) ? `{${key.slice("url:".length)}}` : encoded(key),
    ),
    headers,
  });
};

/** Whether a field's value goes in a header: one the operator can give again once the connector is added. */
const inHeader = (field: ConnectField) => field.target._tag !== "url-variable";

/**
 * The keys of the form's fields that go in a header. A field of the address
 * is not given again: another address is another connector.
 */
export const headerFieldKeys = (form: ConnectForm): ReadonlySet<string> =>
  new Set(form.fields.filter(inHeader).map((field) => field.key));

/**
 * The headers `values` gives anew, as for a token the service refused: each
 * header one of whose fields `values` names, rendered from `values` and,
 * for its other fields, their defaults: each needs one or the other. A
 * header `values` does not touch keeps the value it has. Only a header's
 * fields can be given again: a key of the address's is unknown here.
 */
export const refill = (
  form: ConnectForm,
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
): Result.Result<
  ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
  ReadonlyArray<FieldProblem>
> => {
  const touched = form.headers.filter((header) => keysOf(header).some((key) => values.has(key)));
  const keys = new Set(touched.flatMap(keysOf));
  const { filled, problems } = fill(
    form.fields.filter((field) => inHeader(field) && keys.has(field.key)),
    values,
  );
  const missing = touched.flatMap((header) =>
    keysOf(header)
      .filter((key) => !filled.has(key))
      .map((key): FieldProblem => ({ _tag: "missing", key })),
  );
  const all = [
    ...problems,
    ...missing.filter((one) => !problems.some((problem) => problem.key === one.key)),
  ];
  if (all.length > 0) return Result.fail(all);
  return Result.succeed(
    touched.map((header) => ({ name: header.name, value: renderHeader(header, filled) })),
  );
};

/**
 * The form's fields as a client shows them. A field with a default is not
 * required: left empty, it takes the default, which shows as its placeholder
 * when the publisher gave none.
 */
export const contractFields = (form: ConnectForm): Array<ConnectorField> =>
  form.fields.map((field) => ({
    key: FieldKey.make(field.key),
    label: field.name,
    description: field.description,
    secret: field.secret,
    required: field.required && field.default === null,
    placeholder: field.placeholder ?? field.default,
    choices: field.choices,
  }));
