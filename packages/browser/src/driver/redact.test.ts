// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { dottedPattern, MASKED_VALUE, maskTree, withoutDataPayload } from "./redact.ts";

const patternOf = (values: ReadonlyArray<string>) => {
  const dotted = dottedPattern(values);
  if (dotted._tag !== "pattern") throw new Error(`no pattern: ${dotted._tag}`);
  return dotted.pattern;
};

describe("maskTree", () => {
  it("hides a password wherever the page shows it, and keeps roles and refs", () => {
    const tree = [
      '- textbox "Password" [ref=e3]: correct-horse',
      "- paragraph [ref=e4]: You typed correct-horse",
      '- link "correct-horse" [ref=e5]',
    ].join("\n");
    assert.strictEqual(
      maskTree(tree, patternOf(["correct-horse"])),
      [
        `- textbox "Password" [ref=e3]: ${MASKED_VALUE}`,
        `- paragraph [ref=e4]: You typed ${MASKED_VALUE}`,
        `- link "${MASKED_VALUE}" [ref=e5]`,
      ].join("\n"),
    );
  });

  it("hides a value as Playwright quotes it", () => {
    const value = 'say "hi"\n';
    const tree = '- textbox [ref=e1]: "say \\"hi\\"\\n"';
    assert.notInclude(maskTree(tree, patternOf([value])), "hi");
  });

  it("hides a short value only where it stands as a word", () => {
    const masked = maskTree("- paragraph: pin 42 and 4242", patternOf(["42"]));
    assert.strictEqual(masked, `- paragraph: pin ${MASKED_VALUE} and 4242`);
  });

  it("leaves a ref that happens to hold the value", () => {
    assert.strictEqual(maskTree("- button [ref=e1]", patternOf(["e1"])), "- button [ref=e1]");
  });
});

describe("withoutDataPayload", () => {
  it("keeps a data: address's media type and drops its content", () => {
    assert.strictEqual(withoutDataPayload("data:text/html;base64,PGgxPg=="), "data:text/html,…");
    assert.strictEqual(withoutDataPayload(" \tDATA:image/png,abc"), "data:image/png,…");
    assert.strictEqual(withoutDataPayload("https://example.test/a"), "https://example.test/a");
  });
});
