// SPDX-License-Identifier: AGPL-3.0-or-later
import { answersSecretRequest, secretRequestFieldId } from "@j3-bots/contracts";
import type { SecretRequestAnswerInput } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import type { SecretAnswer } from "../Engine.ts";

/**
 * The engine's answer to a secret request asked with `fieldNames` (empty for
 * one asked for a single value), or undefined when `answer` does not give a
 * value for exactly those fields (`answersSecretRequest`). The card numbers
 * the fields in the order the bot asked for them. The engine takes a request
 * with fields only as `values`, keyed by every one of its names and no other,
 * and one without as `secret` (**Read** at `bc0f04d`, `SecretRequests.ts`,
 * `answerValues`).
 */
export const secretAnswerFor = (
  fieldNames: ReadonlyArray<string>,
  answer: SecretAnswer,
): SecretRequestAnswerInput["answer"] | undefined => {
  const fields = fieldNames.map((name, position) => ({ name, id: secretRequestFieldId(position) }));
  if (!answersSecretRequest(fields, answer)) return undefined;
  switch (answer._tag) {
    case "decline":
      return { type: "decline" };
    case "provide": {
      const value = Redacted.value(answer.value);
      const [only] = fields;
      // A request with one field takes its value alone too, as a client before 0.12.0 sends it.
      return only === undefined
        ? { type: "save", secret: value }
        : { type: "save", values: { [only.name]: value } };
    }
    case "provide-fields": {
      const values: Record<string, string> = {};
      for (const field of fields) {
        const value = answer.values[field.id];
        if (value === undefined) return undefined;
        values[field.name] = Redacted.value(value);
      }
      return { type: "save", values };
    }
  }
};
