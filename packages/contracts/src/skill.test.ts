// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { skillFrontmatter } from "./skill.ts";

const front = (...lines: ReadonlyArray<string>) =>
  ["---", ...lines, "---", "", "Steps."].join("\n");

describe("skillFrontmatter", () => {
  it("reads plain and quoted values, and drops a plain value's comment", () => {
    assert.deepStrictEqual(
      skillFrontmatter(front("name: triage", "description: When triaging # x")),
      {
        name: "triage",
        description: "When triaging",
      },
    );
    assert.deepStrictEqual(
      skillFrontmatter(front(`name: 'triage'`, `description: "When it's \\"urgent\\""`)),
      { name: "triage", description: `When it's "urgent"` },
    );
    assert.deepStrictEqual(
      skillFrontmatter(front("name: triage", "description: 'It''s for triage'")),
      { name: "triage", description: "It's for triage" },
    );
  });

  it("reads a folded or literal block as one description, and Windows line ends", () => {
    assert.deepStrictEqual(
      skillFrontmatter(
        front(
          "name: triage",
          "description: >-",
          "  When triaging",
          "",
          "  new issues",
          "license: MIT",
        ),
      ),
      { name: "triage", description: "When triaging new issues" },
    );
    assert.deepStrictEqual(
      skillFrontmatter(
        front("description: |", "  When triaging", "name: triage").replaceAll("\n", "\r\n"),
      ),
      { name: "triage", description: "When triaging" },
    );
  });

  it("says what is wrong when the frontmatter does not give both", () => {
    assert.isString(skillFrontmatter("name: triage\n"));
    assert.isString(skillFrontmatter("---\nname: triage\ndescription: x\n"));
    assert.isString(skillFrontmatter(front("name: triage")));
    assert.isString(skillFrontmatter(front("description: When triaging")));
    assert.isString(skillFrontmatter(front("name: triage", "description: 'unclosed")));
    assert.isString(skillFrontmatter(front("name: triage", `description: ${"x".repeat(1025)}`)));
    // Keys nested under another one are not the skill's.
    assert.isString(skillFrontmatter(front("metadata:", "  name: triage", "  description: x")));
  });
});
