// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * What a connector's MCP server asks the operator for in the middle of a
 * bot's call (MCP elicitation, decision 0047): a form of a few plain fields,
 * or a page of its own to open. J3 Bots shows it as a card in the
 * conversation of the bot whose call asked, and sends the operator's answer
 * back to the server only; the bot never reads it.
 *
 * The server's requested schema is decoded into these fields, with every
 * text cleaned and capped; a form with a field of any other shape is never
 * shown.
 */

/** The most fields one form shows. */
export const MAX_ELICITATION_FIELDS = 20;
/** The most options one choice offers. */
export const MAX_ELICITATION_OPTIONS = 50;
/** The longest text one answer's field takes, in characters. */
export const MAX_ELICITATION_TEXT = 2_000;

const FieldKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const FieldText = Schema.String.check(Schema.isMaxLength(500));

const field = {
  /** The name the server reads the answer under. */
  key: FieldKey,
  /** What the field asks, in a line: its title, else its key. */
  label: FieldText,
  /** More about it, when the server gave it. */
  description: Schema.NullOr(FieldText),
  required: Schema.Boolean,
};

export const ElicitationField = Schema.Union([
  Schema.TaggedStruct("text", {
    ...field,
    /** How the text must read, which a client checks and gives a fitting keyboard. */
    format: Schema.NullOr(Schema.Literals(["email", "uri", "date", "date-time"])),
    minLength: Schema.NullOr(Schema.Int),
    maxLength: Schema.NullOr(Schema.Int),
    default: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("number", {
    ...field,
    integer: Schema.Boolean,
    minimum: Schema.NullOr(Schema.Finite),
    maximum: Schema.NullOr(Schema.Finite),
    default: Schema.NullOr(Schema.Finite),
  }),
  Schema.TaggedStruct("boolean", {
    ...field,
    default: Schema.NullOr(Schema.Boolean),
  }),
  Schema.TaggedStruct("choice", {
    ...field,
    /** Whether several options may be picked. */
    multiple: Schema.Boolean,
    options: Schema.Array(Schema.Struct({ value: FieldText, label: FieldText })),
    /** For a multiple choice, how few and how many may be picked. */
    minItems: Schema.NullOr(Schema.Int),
    maxItems: Schema.NullOr(Schema.Int),
    default: Schema.Array(FieldText),
  }),
]);
export type ElicitationField = typeof ElicitationField.Type;

/** What a server asks for: a form, or a page to open on the operator's device. */
export const Elicitation = Schema.Union([
  Schema.TaggedStruct("form", {
    /** What the server says it needs, cleaned. */
    message: Schema.String.check(Schema.isMaxLength(2_000)),
    fields: Schema.Array(ElicitationField).check(Schema.isMaxLength(MAX_ELICITATION_FIELDS)),
  }),
  Schema.TaggedStruct("url", {
    message: Schema.String.check(Schema.isMaxLength(2_000)),
    /** An `https:` address the server chose, which the card names by its host before it opens it. */
    url: Schema.String,
    host: Schema.String,
  }),
]);
export type Elicitation = typeof Elicitation.Type;

/** One answer's value: a text, a number, a yes or no, or the options picked. */
export const ElicitationValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(MAX_ELICITATION_TEXT)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(MAX_ELICITATION_OPTIONS),
  ),
]);
export type ElicitationValue = typeof ElicitationValue.Type;

/**
 * The operator's answer: Accept (with the form's values; none for a page),
 * Decline (no), or Cancel (not now, which the server may ask again).
 */
export const ElicitationAnswer = Schema.Union([
  Schema.TaggedStruct("accept", {
    content: Schema.Record(FieldKey, ElicitationValue),
  }),
  Schema.TaggedStruct("decline", {}),
  Schema.TaggedStruct("cancel", {}),
]);
export type ElicitationAnswer = typeof ElicitationAnswer.Type;

/** Whether `content` answers `fields`: every required field given, each value of its field's kind and within its bounds, nothing else. */
export const answersFields = (
  fields: ReadonlyArray<ElicitationField>,
  content: Readonly<Record<string, ElicitationValue>>,
): boolean => {
  const keys = new Set(fields.map((f) => f.key));
  if (Object.keys(content).some((key) => !keys.has(key))) return false;
  return fields.every((f) => {
    const value = content[f.key];
    if (value === undefined) return !f.required;
    switch (f._tag) {
      case "text":
        return (
          typeof value === "string" &&
          (f.minLength === null || [...value].length >= f.minLength) &&
          (f.maxLength === null || [...value].length <= f.maxLength)
        );
      case "number":
        return (
          typeof value === "number" &&
          (!f.integer || Number.isInteger(value)) &&
          (f.minimum === null || value >= f.minimum) &&
          (f.maximum === null || value <= f.maximum)
        );
      case "boolean":
        return typeof value === "boolean";
      case "choice": {
        const allowed = new Set(f.options.map((o) => o.value));
        if (!f.multiple) return typeof value === "string" && allowed.has(value);
        return (
          typeof value === "object" &&
          value.every((v) => allowed.has(v)) &&
          new Set(value).size === value.length &&
          (f.minItems === null || value.length >= f.minItems) &&
          (f.maxItems === null || value.length <= f.maxItems)
        );
      }
    }
  });
};
