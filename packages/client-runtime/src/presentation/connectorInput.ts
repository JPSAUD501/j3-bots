// SPDX-License-Identifier: AGPL-3.0-or-later
import { answersFields, type ElicitationField, type ElicitationValue } from "@j3-bots/contracts";

/**
 * What the operator has entered in one field of a connector's form so far: a
 * text or a number as typed, a yes or no, or the options picked.
 */
export type InputDraft = string | boolean | ReadonlyArray<string>;

/** Why a field cannot be sent as it is: it is required and empty, or what it holds does not fit. */
export type InputProblem = "required" | "invalid";

/** Each field as the form opens: the server's default, or empty; a yes or no starts at no. */
export function inputDrafts(
  fields: ReadonlyArray<ElicitationField>,
): Readonly<Record<string, InputDraft>> {
  return Object.fromEntries(
    fields.map((field): [string, InputDraft] => {
      switch (field._tag) {
        case "text":
          return [field.key, field.default ?? ""];
        case "number":
          return [field.key, field.default === null ? "" : String(field.default)];
        case "boolean":
          return [field.key, field.default ?? false];
        case "choice":
          return [field.key, field.multiple ? field.default : field.default.slice(0, 1)];
      }
    }),
  );
}

const FORMATS = {
  email: (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text),
  uri: (text: string) => URL.canParse(text),
  date: (text: string) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)),
  "date-time": (text: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text) &&
    !Number.isNaN(Date.parse(text)),
} as const;

/** The value a field sends, `undefined` when it is left out, or why it cannot be sent. */
const valueOf = (
  field: ElicitationField,
  draft: InputDraft | undefined,
): { readonly value: ElicitationValue | undefined } | { readonly problem: InputProblem } => {
  const empty = { value: undefined } as const;
  switch (field._tag) {
    case "text": {
      const text = typeof draft === "string" ? draft : "";
      if (text === "") return field.required ? { problem: "required" } : empty;
      const length = [...text].length;
      const fits =
        (field.minLength === null || length >= field.minLength) &&
        (field.maxLength === null || length <= field.maxLength) &&
        (field.format === null || FORMATS[field.format](text));
      return fits ? { value: text } : { problem: "invalid" };
    }
    case "number": {
      const text = typeof draft === "string" ? draft.trim() : "";
      if (text === "") return field.required ? { problem: "required" } : empty;
      const value = Number(text);
      const fits =
        Number.isFinite(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (field.minimum === null || value >= field.minimum) &&
        (field.maximum === null || value <= field.maximum);
      return fits ? { value } : { problem: "invalid" };
    }
    case "boolean":
      return { value: draft === true };
    case "choice": {
      const picked = typeof draft === "object" ? draft : [];
      const allowed = picked.filter((value) => field.options.some((o) => o.value === value));
      if (!field.multiple) {
        const [one] = allowed;
        if (one === undefined) return field.required ? { problem: "required" } : empty;
        return { value: one };
      }
      if (allowed.length === 0 && field.minItems === null) {
        return field.required ? { problem: "required" } : empty;
      }
      const fits =
        (field.minItems === null || allowed.length >= field.minItems) &&
        (field.maxItems === null || allowed.length <= field.maxItems);
      return fits ? { value: allowed } : { problem: "invalid" };
    }
  }
};

/** Why `field` cannot be sent as `draft` holds it, or null when it can. */
export function inputProblem(
  field: ElicitationField,
  draft: InputDraft | undefined,
): InputProblem | null {
  const result = valueOf(field, draft);
  return "problem" in result ? result.problem : null;
}

/**
 * What Send gives the server from the operator's drafts: each field's value,
 * those left empty left out; null while some field cannot be sent.
 */
export function inputContent(
  fields: ReadonlyArray<ElicitationField>,
  drafts: Readonly<Record<string, InputDraft>>,
): Readonly<Record<string, ElicitationValue>> | null {
  const content: Record<string, ElicitationValue> = {};
  for (const field of fields) {
    const result = valueOf(field, drafts[field.key]);
    if ("problem" in result) return null;
    if (result.value !== undefined) content[field.key] = result.value;
  }
  return answersFields(fields, content) ? content : null;
}
