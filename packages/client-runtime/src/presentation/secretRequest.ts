// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_SECRET_REQUEST_VALUE_LENGTH,
  type SecretRequestAnswer,
  type SecretRequestEntry,
  type SecretRequestFieldId,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";

/** What a secret request's answer carries when it is not a decline: its values. */
export type SecretRequestValues = Exclude<SecretRequestAnswer, { readonly _tag: "decline" }>;

/**
 * One input of a secret request card. `autofill` is what a password manager
 * may fill into it: the user name and password of a login, which a card asks
 * for as a shown value followed by a masked one. Every other input takes
 * nothing from autofill, so a key or a code is never offered a saved password.
 */
export interface SecretRequestInput {
  /** The id its value is answered under; null for a request for one value. */
  readonly id: SecretRequestFieldId | null;
  readonly label: string;
  readonly placeholder: string | null;
  /** Hidden as it is typed, with a way to show it. */
  readonly masked: boolean;
  readonly autofill: "username" | "password" | null;
}

/**
 * What a secret request card asks the operator to type: an input per value,
 * in order. A request for one value (`fields` empty) has one masked input,
 * labelled with the request's own label.
 */
export const secretRequestInputs = (
  entry: Pick<SecretRequestEntry, "label" | "placeholder" | "fields">,
): ReadonlyArray<SecretRequestInput> => {
  if (entry.fields.length === 0) {
    return [
      {
        id: null,
        label: entry.label,
        placeholder: entry.placeholder,
        masked: true,
        autofill: null,
      },
    ];
  }
  const { fields } = entry;
  return fields.map((field, position) => {
    const before = fields[position - 1];
    const after = fields[position + 1];
    return {
      id: field.id,
      label: field.label,
      placeholder: field.placeholder,
      masked: field.masked,
      autofill:
        !field.masked && after?.masked === true
          ? "username"
          : field.masked && before?.masked === false
            ? "password"
            : null,
    };
  });
};

/**
 * Whether a typed value is longer than a secret request takes. A card says so
 * at the input, rather than cutting the value short: a credential sent in part
 * would fail later, somewhere the operator cannot see why.
 */
export const secretValueTooLong = (value: string): boolean =>
  value.length > MAX_SECRET_REQUEST_VALUE_LENGTH;

/**
 * The answer to send for the `values` typed into `inputs`, in the same order,
 * or the first input whose value cannot be sent and why: still blank (spaces
 * alone count, since the engine takes none) or too long.
 */
export const secretRequestAnswer = (
  inputs: ReadonlyArray<SecretRequestInput>,
  values: ReadonlyArray<string>,
):
  | { readonly _tag: "answer"; readonly answer: SecretRequestValues }
  | {
      readonly _tag: "unfit";
      readonly position: number;
      readonly problem: "blank" | "tooLong";
    } => {
  for (const position of inputs.keys()) {
    const value = values[position] ?? "";
    if (value.trim() === "") return { _tag: "unfit", position, problem: "blank" };
    if (secretValueTooLong(value)) return { _tag: "unfit", position, problem: "tooLong" };
  }
  const [only] = inputs;
  if (inputs.length === 1 && only?.id === null) {
    return { _tag: "answer", answer: { _tag: "provide", value: Redacted.make(values[0] ?? "") } };
  }
  const answered: Record<SecretRequestFieldId, Redacted.Redacted<string>> = {};
  for (const [position, input] of inputs.entries()) {
    if (input.id !== null) answered[input.id] = Redacted.make(values[position] ?? "");
  }
  return { _tag: "answer", answer: { _tag: "provide-fields", values: answered } };
};
