// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { MAX_HIGHLIGHT_LENGTH, MAX_HIGHLIGHTS } from "@j3-bots/contracts";
import { highlightsOf, whatsNewOf } from "./notes.ts";

const notes = `# J3 Bots 9.1.0

One line on what this release is.

## Updating

- **The server first:** from the update prompt.
- **Then the apps.**

## What’s new

- **A bot keeps a garden** ([#901](https://example.test/pull/901)). It waters it on a routine.
  - **A nested item** is not a highlight.
- A plain item is not one either.
- **Rooms read \`notes\` and [links](https://example.test)** (#902).

  A paragraph under an item.

### Details

- **A deeper heading stays in the section** (#903).

## Known limits

- **Not a highlight:** another section.
`;

describe("the highlights of a release", () => {
  it("are the bold leads of the top-level items under What's new, in order, as plain text", () => {
    assert.deepStrictEqual(highlightsOf(notes), [
      "A bot keeps a garden",
      "Rooms read notes and links",
      "A deeper heading stays in the section",
    ]);
  });

  it("are none without notes or without a What's new section", () => {
    assert.deepStrictEqual(highlightsOf(null), []);
    assert.deepStrictEqual(highlightsOf(undefined), []);
    assert.deepStrictEqual(highlightsOf("# J3 Bots 9.1.0\n\n- **Not under the heading**\n"), []);
  });

  it("are at most the contract's count, each within its length, cut at a word", () => {
    const many = ["## What's new", ...Array.from({ length: 8 }, (_, i) => `- **Item ${i}**`)];
    assert.strictEqual(highlightsOf(many.join("\n")).length, MAX_HIGHLIGHTS);
    const long = `## What's new\n- **${"word ".repeat(60)}**`;
    const [only] = highlightsOf(long);
    assert.isDefined(only);
    assert.isAtMost(only.length, MAX_HIGHLIGHT_LENGTH);
    assert.match(only, /word…$/);
  });
});

describe("the What's new section of a release", () => {
  it("is the section as written, from under its heading to the next section", () => {
    const section = whatsNewOf(notes);
    assert.isNotNull(section);
    assert.isTrue(section?.startsWith("- **A bot keeps a garden** ([#901]"));
    assert.include(section, "  A paragraph under an item.\n\n### Details\n");
    assert.isTrue(section?.endsWith("- **A deeper heading stays in the section** (#903)."));
  });

  it("is none without the section, or when it holds nothing", () => {
    assert.isNull(whatsNewOf("# J3 Bots 9.1.0\n\n## Updating\n\n- **The server**\n"));
    assert.isNull(whatsNewOf("## What's new\n\n\n## Known limits\n\n- **A limit**\n"));
  });
});
