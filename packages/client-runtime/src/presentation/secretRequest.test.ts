// SPDX-License-Identifier: AGPL-3.0-or-later
import { secretRequestFieldId, type SecretRequestField } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { secretRequestAnswer, secretRequestInputs } from "./secretRequest.ts";

const field = (position: number, label: string, masked: boolean): SecretRequestField => ({
  id: secretRequestFieldId(position),
  label,
  placeholder: null,
  masked,
});

const request = (fields: ReadonlyArray<SecretRequestField>) => ({
  label: "Sign in to Mail",
  placeholder: null,
  fields,
});

describe("secretRequestInputs", () => {
  it("offers a password manager a login's user name and password, and nothing else", () => {
    const inputs = secretRequestInputs(
      request([
        field(0, "Email", false),
        field(1, "Password", true),
        field(2, "Recovery code", true),
        field(3, "Server", false),
      ]),
    );

    assert.deepStrictEqual(
      inputs.map((input) => input.autofill),
      ["username", "password", null, null],
    );
  });

  it("asks for one masked value, under the request's label, when it names no fields", () => {
    const inputs = secretRequestInputs({ label: "npm token", placeholder: "npm_…", fields: [] });

    assert.deepStrictEqual(inputs, [
      { id: null, label: "npm token", placeholder: "npm_…", masked: true, autofill: null },
    ]);
  });
});

describe("secretRequestAnswer", () => {
  const login = secretRequestInputs(
    request([field(0, "Email", false), field(1, "Password", true)]),
  );

  it("answers every field under its id", () => {
    const result = secretRequestAnswer(login, ["someone@example.com", " pass word "]);

    assert(result._tag === "answer" && result.answer._tag === "provide-fields");
    assert.deepStrictEqual(
      Object.entries(result.answer.values).map(([id, value]) => [id, Redacted.value(value)]),
      [
        ["field-1", "someone@example.com"],
        ["field-2", " pass word "],
      ],
    );
  });

  it("names the first value still blank, spaces alone included, and sends nothing", () => {
    assert.deepStrictEqual(secretRequestAnswer(login, ["someone@example.com", ""]), {
      _tag: "blank",
      position: 1,
    });
    assert.deepStrictEqual(secretRequestAnswer(login, ["   ", ""]), {
      _tag: "blank",
      position: 0,
    });
  });

  it("answers a request for one value with that value alone", () => {
    const one = secretRequestInputs({ label: "npm token", placeholder: null, fields: [] });
    const result = secretRequestAnswer(one, ["npm_example"]);

    assert(result._tag === "answer" && result.answer._tag === "provide");
    assert.strictEqual(Redacted.value(result.answer.value), "npm_example");
  });
});
