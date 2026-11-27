// SPDX-License-Identifier: AGPL-3.0-or-later
import { secretRequestFieldId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { secretAnswerFor } from "./secretAnswer.ts";

const value = (text: string) => Redacted.make(text);

describe("secretAnswerFor", () => {
  it("saves each value under the name the bot asked for it with, by the card's order", () => {
    const answer = secretAnswerFor(["email", "password"], {
      _tag: "provide-fields",
      values: {
        [secretRequestFieldId(1)]: value("example-password"),
        [secretRequestFieldId(0)]: value("someone@example.com"),
      },
    });

    assert.deepStrictEqual(answer, {
      type: "save",
      values: { email: "someone@example.com", password: "example-password" },
    });
  });

  it("saves a request for one value as its secret, and one field's value under its name", () => {
    const provide = { _tag: "provide", value: value("example-token") } as const;

    assert.deepStrictEqual(secretAnswerFor([], provide), {
      type: "save",
      secret: "example-token",
    });
    assert.deepStrictEqual(secretAnswerFor(["token"], provide), {
      type: "save",
      values: { token: "example-token" },
    });
  });

  it("refuses an answer that leaves out a field, adds one, or gives one value for several", () => {
    const names = ["email", "password"];

    assert.isUndefined(
      secretAnswerFor(names, {
        _tag: "provide-fields",
        values: { [secretRequestFieldId(0)]: value("someone@example.com") },
      }),
    );
    assert.isUndefined(
      secretAnswerFor(names, {
        _tag: "provide-fields",
        values: {
          [secretRequestFieldId(0)]: value("someone@example.com"),
          [secretRequestFieldId(2)]: value("example-password"),
        },
      }),
    );
    assert.isUndefined(secretAnswerFor(names, { _tag: "provide", value: value("both") }));
    assert.isUndefined(
      secretAnswerFor([], {
        _tag: "provide-fields",
        values: { [secretRequestFieldId(0)]: value("example-token") },
      }),
    );
  });

  it("declines whatever the request asks for", () => {
    assert.deepStrictEqual(secretAnswerFor(["email", "password"], { _tag: "decline" }), {
      type: "decline",
    });
  });
});
