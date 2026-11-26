// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ElicitationField } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { inputContent, inputDrafts, inputProblem } from "./connectorInput.ts";

const base = { description: null, required: false } as const;

const fields: ReadonlyArray<ElicitationField> = [
  {
    ...base,
    _tag: "text",
    key: "email",
    label: "Email",
    required: true,
    format: "email",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...base,
    _tag: "number",
    key: "copies",
    label: "Copies",
    integer: true,
    minimum: 1,
    maximum: 5,
    default: 2,
  },
  { ...base, _tag: "boolean", key: "notify", label: "Notify", default: null },
  {
    ...base,
    _tag: "choice",
    key: "tags",
    label: "Tags",
    multiple: true,
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    minItems: null,
    maxItems: 1,
    default: [],
  },
];

describe("a connector's form", () => {
  it("opens with the server's defaults, and a yes or no at no", () => {
    expect(inputDrafts(fields)).toEqual({ email: "", copies: "2", notify: false, tags: [] });
  });

  it("sends each value as its field takes it, and leaves out an optional one left empty", () => {
    const drafts = { ...inputDrafts(fields), email: "sam@example.com", copies: " 3 " };
    expect(inputContent(fields, drafts)).toEqual({
      email: "sam@example.com",
      copies: 3,
      notify: false,
    });
  });

  it("sends nothing while a field is required and empty, or holds what it does not take", () => {
    const [email, copies, , tags] = fields;
    const drafts = inputDrafts(fields);
    expect(inputContent(fields, drafts)).toBeNull();
    expect(email && inputProblem(email, "")).toBe("required");
    expect(email && inputProblem(email, "sam")).toBe("invalid");
    expect(copies && inputProblem(copies, "2.5")).toBe("invalid");
    expect(copies && inputProblem(copies, "9")).toBe("invalid");
    expect(copies && inputProblem(copies, "")).toBeNull();
    expect(tags && inputProblem(tags, ["a", "b"])).toBe("invalid");
    expect(tags && inputProblem(tags, ["a", "z"])).toBeNull();
  });
});
