// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Elicitation,
  type ElicitationAnswer,
  type ElicitationField,
  MAX_ELICITATION_FIELDS,
  MAX_ELICITATION_OPTIONS,
} from "@j3-bots/contracts";
import type { ElicitResult } from "@modelcontextprotocol/client";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { cap, cleanText } from "./catalog.ts";

/**
 * A server's elicitation request (MCP 2025-11-25 and 2026-07-28), decoded at
 * the boundary into what J3 Bots shows (`@j3-bots/contracts`' `Elicitation`),
 * and the operator's answer as the server reads it.
 *
 * A form asks for plain values only: MCP says a server must not ask for a
 * password, a key or a token through one, and use a page of its own (URL
 * mode) instead. J3 Bots holds it to that: a form with a field that names a
 * secret is declined without being shown.
 */

const Text = Schema.optionalKey(Schema.String);
const Count = Schema.optionalKey(Schema.Int);

const StringProperty = Schema.Struct({
  type: Schema.Literal("string"),
  title: Text,
  description: Text,
  minLength: Count,
  maxLength: Count,
  format: Schema.optionalKey(Schema.String),
  default: Text,
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Labels for `enum`, as the 2025-06-18 revision gave them. */
  enumNames: Schema.optionalKey(Schema.Array(Schema.String)),
  oneOf: Schema.optionalKey(Schema.Array(Schema.Struct({ const: Schema.String, title: Text }))),
});

const NumberProperty = Schema.Struct({
  type: Schema.Literals(["number", "integer"]),
  title: Text,
  description: Text,
  minimum: Schema.optionalKey(Schema.Finite),
  maximum: Schema.optionalKey(Schema.Finite),
  default: Schema.optionalKey(Schema.Finite),
});

const BooleanProperty = Schema.Struct({
  type: Schema.Literal("boolean"),
  title: Text,
  description: Text,
  default: Schema.optionalKey(Schema.Boolean),
});

const ArrayProperty = Schema.Struct({
  type: Schema.Literal("array"),
  title: Text,
  description: Text,
  minItems: Count,
  maxItems: Count,
  items: Schema.Union([
    Schema.Struct({ type: Schema.Literal("string"), enum: Schema.Array(Schema.String) }),
    Schema.Struct({
      anyOf: Schema.Array(Schema.Struct({ const: Schema.String, title: Text })),
    }),
  ]),
  default: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Property = Schema.Union([StringProperty, NumberProperty, BooleanProperty, ArrayProperty]);

const FormRequest = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literal("form")),
  message: Schema.String,
  requestedSchema: Schema.Struct({
    type: Schema.Literal("object"),
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});

const UrlRequest = Schema.Struct({
  mode: Schema.Literal("url"),
  message: Schema.String,
  url: Schema.String,
});

const decodeForm = Schema.decodeUnknownResult(FormRequest);
const decodeUrl = Schema.decodeUnknownResult(UrlRequest);
const decodeProperty = Schema.decodeUnknownResult(Property);

/** A field's key, label or description that names a secret, which a form must not ask for. */
const SECRET_WORDS =
  /(?:^|[^a-z])(pass(?:word|phrase|code)?|secret|credentials?|api[-_ ]?key|private[-_ ]?key|access[-_ ]?key|token|pin|otp|totp|2fa|mfa|one[-_ ]?time|authenticator|(?:verification|security|recovery|auth(?:entication)?|login|sign[-_ ]?in)[-_ ]?code|cvv|cvc|ssn)(?:$|[^a-z])/iu;

const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** Text the operator reads: cleaned, one line, capped. */
const line = (text: string, max: number) => cap(cleanText(text).replace(/\s+/gu, " ").trim(), max);

type TextFormat = "email" | "uri" | "date" | "date-time";
const FORMATS: ReadonlyArray<TextFormat> = ["email", "uri", "date", "date-time"];
const isFormat = (format: string): format is TextFormat => FORMATS.some((f) => f === format);

const fieldOf = (
  key: string,
  raw: unknown,
  required: boolean,
): Result.Result<ElicitationField, ElicitationRefusal> => {
  if (!KEY.test(key)) return Result.fail("unsupported-field");
  const decoded = decodeProperty(raw);
  if (Result.isFailure(decoded)) return Result.fail("unsupported-field");
  const property = decoded.success;
  const label = line(property.title ?? key, 200) || key;
  const description =
    property.description === undefined ? null : line(property.description, 500) || null;
  if ([key, label, description ?? ""].some((text) => SECRET_WORDS.test(text))) {
    return Result.fail("secret");
  }
  const base = { key, label, description, required };
  switch (property.type) {
    case "string": {
      const options =
        property.oneOf?.map((o) => ({ value: o.const, title: o.title })) ??
        property.enum?.map((value, i) => ({ value, title: property.enumNames?.[i] }));
      if (options !== undefined) {
        return choiceOf(
          base,
          false,
          options,
          property.default === undefined ? [] : [property.default],
          null,
          null,
        );
      }
      const format = property.format ?? null;
      if (format !== null && !isFormat(format)) return Result.fail("unsupported-field");
      return Result.succeed({
        _tag: "text",
        ...base,
        format,
        minLength: property.minLength ?? null,
        maxLength: property.maxLength ?? null,
        default: property.default ?? null,
      });
    }
    case "number":
    case "integer":
      return Result.succeed({
        _tag: "number",
        ...base,
        integer: property.type === "integer",
        minimum: property.minimum ?? null,
        maximum: property.maximum ?? null,
        default: property.default ?? null,
      });
    case "boolean":
      return Result.succeed({ _tag: "boolean", ...base, default: property.default ?? null });
    case "array": {
      const items = property.items;
      const options =
        "anyOf" in items
          ? items.anyOf.map((o) => ({ value: o.const, title: o.title }))
          : items.enum.map((value) => ({ value, title: undefined }));
      return choiceOf(
        base,
        true,
        options,
        property.default ?? [],
        property.minItems ?? null,
        property.maxItems ?? null,
      );
    }
  }
};

const choiceOf = (
  base: Pick<ElicitationField, "key" | "label" | "description" | "required">,
  multiple: boolean,
  raw: ReadonlyArray<{ readonly value: string; readonly title: string | undefined }>,
  defaults: ReadonlyArray<string>,
  minItems: number | null,
  maxItems: number | null,
): Result.Result<ElicitationField, ElicitationRefusal> => {
  if (raw.length === 0 || raw.length > MAX_ELICITATION_OPTIONS) {
    return Result.fail("unsupported-field");
  }
  // A value the operator picks goes back as it is, so one cleaning would change is not offered.
  if (raw.some((o) => o.value.length > 500 || cleanText(o.value) !== o.value)) {
    return Result.fail("unsupported-field");
  }
  const options = raw.map((o) => ({
    value: o.value,
    label: line(o.title ?? o.value, 200) || o.value,
  }));
  const values = new Set(options.map((o) => o.value));
  return Result.succeed({
    _tag: "choice",
    ...base,
    multiple,
    options,
    minItems,
    maxItems,
    default: defaults.filter((value) => values.has(value)),
  });
};

/** Why a request is not shown to the operator. */
export type ElicitationRefusal = "malformed" | "unsupported-field" | "secret" | "not-https";

/**
 * A server's elicitation request as J3 Bots shows it, or why it is not
 * shown: a form with a field of a shape J3 Bots does not offer, or one
 * naming a secret, and a page not on `https:`, are each declined.
 */
export const elicitationOf = (params: unknown): Result.Result<Elicitation, ElicitationRefusal> => {
  const url = decodeUrl(params);
  if (Result.isSuccess(url)) {
    const parsed = URL.parse(url.success.url);
    if (
      parsed === null ||
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return Result.fail("not-https");
    }
    return Result.succeed({
      _tag: "url",
      message: cap(cleanText(url.success.message).trim(), 2_000),
      url: parsed.href,
      host: parsed.host,
    });
  }
  const form = decodeForm(params);
  if (Result.isFailure(form)) return Result.fail("malformed");
  const { properties, required = [] } = form.success.requestedSchema;
  const entries = Object.entries(properties);
  if (entries.length > MAX_ELICITATION_FIELDS) return Result.fail("unsupported-field");
  const fields: Array<ElicitationField> = [];
  for (const [key, raw] of entries) {
    const field = fieldOf(key, raw, required.includes(key));
    if (Result.isFailure(field)) return Result.fail(field.failure);
    fields.push(field.success);
  }
  return Result.succeed({
    _tag: "form",
    message: cap(cleanText(form.success.message).trim(), 2_000),
    fields,
  });
};

/** The operator's answer as MCP's `ElicitResult`. */
export const elicitResultOf = (answer: ElicitationAnswer): ElicitResult => {
  switch (answer._tag) {
    case "accept":
      return {
        action: "accept",
        content: Object.fromEntries(
          Object.entries(answer.content).map(([key, value]) => [
            key,
            typeof value === "object" ? [...value] : value,
          ]),
        ),
      };
    case "decline":
      return { action: "decline" };
    case "cancel":
      return { action: "cancel" };
  }
};
