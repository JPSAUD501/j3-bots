// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { parseMessageText } from "./messageText";

const inlinesOf = (text: string, mentionable: ReadonlyArray<string> = []) => {
  const [block] = parseMessageText(text, mentionable);
  return block?.kind === "paragraph" ? block.inlines : [];
};

describe("parseMessageText", () => {
  it("splits paragraphs and fenced code", () => {
    expect(parseMessageText("First.\n\n```ts\nconst a = 1;\n```\nAfter")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "First." }] },
      { kind: "code", language: "ts", text: "const a = 1;" },
      { kind: "paragraph", inlines: [{ kind: "text", text: "After" }] },
    ]);
  });

  it("finds inline code", () => {
    expect(inlinesOf("Run `pnpm test` now")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " now" },
    ]);
  });

  it("leaves sentence punctuation and an unopened parenthesis out of a link", () => {
    expect(inlinesOf("(see https://example.com/a).")).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", href: "https://example.com/a", text: "https://example.com/a" },
      { kind: "text", text: ")." },
    ]);
    expect(inlinesOf("https://example.com/wiki/Foo_(bar)")).toEqual([
      {
        kind: "link",
        href: "https://example.com/wiki/Foo_(bar)",
        text: "https://example.com/wiki/Foo_(bar)",
      },
    ]);
  });

  it("links only web addresses", () => {
    for (const text of ["javascript:alert(1)", "ftp://example.com/file", "file:///etc/passwd"]) {
      expect(
        inlinesOf(text).every((i) => i.kind === "text"),
        text,
      ).toBe(true);
    }
  });

  it("marks a mention only for a name the message addressed", () => {
    expect(inlinesOf("@Wren and @Nobody, also @everyone", ["Wren"])).toEqual([
      { kind: "mention", name: "Wren" },
      { kind: "text", text: " and @Nobody, also @everyone" },
    ]);
    expect(inlinesOf("@Wren, @everyone", ["everyone"])).toEqual([
      { kind: "text", text: "@Wren, " },
      { kind: "mention", name: "everyone" },
    ]);
  });
});
