// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { elicitationOf } from "./elicitation.ts";

const form = (properties: Record<string, unknown>, required: ReadonlyArray<string> = []) => ({
  mode: "form",
  message: "Pick one",
  requestedSchema: { type: "object", properties, required },
});

describe("elicitationOf", () => {
  it("reads every field MCP allows: text, number, yes or no, and single and multiple choices", () => {
    const shown = elicitationOf(
      form(
        {
          email: { type: "string", format: "email", title: "Email" },
          count: { type: "integer", minimum: 1, maximum: 9 },
          ok: { type: "boolean", default: true },
          color: {
            type: "string",
            oneOf: [
              { const: "r", title: "Red" },
              { const: "g", title: "Green" },
            ],
          },
          size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
          tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] }, maxItems: 1 },
        },
        ["email"],
      ),
    );
    expect(
      Result.isSuccess(shown) && shown.success._tag === "form" ? shown.success.fields : [],
    ).toEqual([
      {
        _tag: "text",
        key: "email",
        label: "Email",
        description: null,
        required: true,
        format: "email",
        minLength: null,
        maxLength: null,
        default: null,
      },
      {
        _tag: "number",
        key: "count",
        label: "count",
        description: null,
        required: false,
        integer: true,
        minimum: 1,
        maximum: 9,
        default: null,
      },
      {
        _tag: "boolean",
        key: "ok",
        label: "ok",
        description: null,
        required: false,
        default: true,
      },
      {
        _tag: "choice",
        key: "color",
        label: "color",
        description: null,
        required: false,
        multiple: false,
        options: [
          { value: "r", label: "Red" },
          { value: "g", label: "Green" },
        ],
        minItems: null,
        maxItems: null,
        default: [],
      },
      {
        _tag: "choice",
        key: "size",
        label: "size",
        description: null,
        required: false,
        multiple: false,
        options: [
          { value: "s", label: "Small" },
          { value: "m", label: "Medium" },
        ],
        minItems: null,
        maxItems: null,
        default: [],
      },
      {
        _tag: "choice",
        key: "tags",
        label: "tags",
        description: null,
        required: false,
        multiple: true,
        options: [{ value: "a", label: "A" }],
        minItems: null,
        maxItems: 1,
        default: [],
      },
    ]);
  });

  it("declines a form that asks for a secret, by its key, its label or its description", () => {
    expect(elicitationOf(form({ api_key: { type: "string" } }))).toEqual(Result.fail("secret"));
    expect(elicitationOf(form({ code: { type: "string", title: "Your password" } }))).toEqual(
      Result.fail("secret"),
    );
    expect(
      elicitationOf(
        form({
          code: {
            type: "string",
            title: "Verification",
            description: "Enter your account password",
          },
        }),
      ),
    ).toEqual(Result.fail("secret"));
    expect(
      elicitationOf(
        form({
          code: {
            type: "string",
            title: "Verification",
            description: "Enter the one-time code from your authenticator.",
          },
        }),
      ),
    ).toEqual(Result.fail("secret"));
    expect(
      Result.isSuccess(elicitationOf(form({ zip: { type: "string", title: "Postal code" } }))),
    ).toBe(true);
  });

  it("declines a form with a field of a shape it does not offer, and a page not on https", () => {
    expect(elicitationOf(form({ files: { type: "object" } }))).toEqual(
      Result.fail("unsupported-field"),
    );
    expect(elicitationOf(form({ when: { type: "string", format: "time" } }))).toEqual(
      Result.fail("unsupported-field"),
    );
    expect(
      elicitationOf({ mode: "url", message: "Open", url: "http://approve.notes.example/" }),
    ).toEqual(Result.fail("not-https"));
  });
});
