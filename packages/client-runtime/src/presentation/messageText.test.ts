// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type Block, type Inline, type MentionName, parseMessageText } from "./messageText.ts";

/** What a part shows, without where it stands in the text: the subject of most tests here. */
const shown = (inline: Inline) => {
  if (inline.kind === "file") return inline;
  const { at: _at, ...rest } = inline;
  return rest;
};
const shownBlocks = (blocks: ReadonlyArray<Block>) =>
  blocks.map((block) => {
    if (block.kind === "code") {
      const { at: _at, ...rest } = block;
      return rest;
    }
    return { kind: block.kind, inlines: block.inlines.map(shown) };
  });

const bot = (name: string, id: string) =>
  ({ name, of: { _tag: "bot", botId: BotId.make(id) } }) satisfies MentionName;
const wren = bot("Wren", "wren");
const ana = bot("Ana", "ana");
const anaLima = bot("Ana Lima", "ana-lima");
const hal = bot("Hal", "hal");
const everyone = { name: "everyone", of: null } satisfies MentionName;

const inlinesOf = (text: string, mentionable: ReadonlyArray<MentionName> = []) => {
  const [block] = parseMessageText(text, mentionable);
  return block?.kind === "paragraph" ? block.inlines.map(shown) : [];
};

const mention = ({ name, of }: MentionName) => ({ kind: "mention", name, of }) as const;

describe("parseMessageText", () => {
  it("splits paragraphs and fenced code", () => {
    expect(shownBlocks(parseMessageText("First.\n\n```ts\nconst a = 1;\n```\nAfter"))).toEqual([
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
    expect(inlinesOf("@Wren and @Nobody, also @everyone", [wren])).toEqual([
      mention(wren),
      { kind: "text", text: " and @Nobody, also @everyone" },
    ]);
    expect(inlinesOf("@Wren, @everyone", [everyone])).toEqual([
      { kind: "text", text: "@Wren, " },
      mention(everyone),
    ]);
  });

  it("marks a name of several words, the longer of two that fit", () => {
    expect(inlinesOf("@Ana Lima and @Ana, see", [ana, anaLima])).toEqual([
      mention(anaLima),
      { kind: "text", text: " and " },
      mention(ana),
      { kind: "text", text: ", see" },
    ]);
  });

  it("marks a name two members share as the first of them", () => {
    const otherAna = bot("Ana", "other-ana");
    expect(inlinesOf("@Ana", [ana, otherAna])).toEqual([mention(ana)]);
  });

  it("marks a name where a mention opens and ends, as the composer reads one", () => {
    // Inside an address it opens no mention, though the message mentions Ana elsewhere.
    expect(inlinesOf("mail@Ana, @Ana", [ana])).toEqual([
      { kind: "text", text: "mail@Ana, " },
      mention(ana),
    ]);
    // A hyphen ends the name, as it does where the operator picked it.
    expect(inlinesOf("@Hal-bot", [hal])).toEqual([mention(hal), { kind: "text", text: "-bot" }]);
    expect(inlinesOf("@Halbot", [hal])).toEqual([{ kind: "text", text: "@Halbot" }]);
  });

  it("ends a link at a backtick, which opens code that holds no mention", () => {
    expect(inlinesOf("https://example.test/` note @Ana `", [ana])).toEqual([
      { kind: "link", href: "https://example.test/", text: "https://example.test/" },
      { kind: "code", text: " note @Ana " },
    ]);
  });
});

describe("parseMessageText with files placed in the text", () => {
  it("shows no file in the text of a message that placed none", () => {
    expect(shownBlocks(parseMessageText("Here are the notes."))).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Here are the notes." }] },
    ]);
  });

  it("puts a file before the code, link or mention it is placed at, and after one it would split", () => {
    const text = "see `a` https://x.dev @Ana end";
    const [block] = parseMessageText(text, [ana], [4, 8, 24, 30]);
    expect(block).toEqual({
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "see ", at: 0 },
        { kind: "file", index: 0 },
        { kind: "code", text: "a", at: 5 },
        { kind: "text", text: " ", at: 7 },
        { kind: "file", index: 1 },
        { kind: "link", href: "https://x.dev", text: "https://x.dev", at: 8 },
        { kind: "text", text: " ", at: 21 },
        { ...mention(ana), at: 22 },
        { kind: "file", index: 2 },
        { kind: "text", text: " end", at: 26 },
        { kind: "file", index: 3 },
      ],
    });
  });

  it("says where each part it shows stands in the text, so a selection maps back to it", () => {
    const text = "Hi @Ana,\n\nrun `pnpm i` then see https://x.dev/a.\n```sh\nls -la\n```\nok";
    for (const block of parseMessageText(text, [ana])) {
      if (block.kind === "code") {
        expect(text.slice(block.at, block.at + block.text.length)).toBe(block.text);
        continue;
      }
      for (const inline of block.inlines) {
        if (inline.kind === "file") continue;
        const written = inline.kind === "mention" ? `@${inline.name}` : inline.text;
        expect(text.slice(inline.at, inline.at + written.length)).toBe(written);
      }
    }
  });

  it("keeps a file placed at a code block before it, and one inside it after it", () => {
    const text = "Look:\n```\ncode\n```";
    expect(shownBlocks(parseMessageText(text, [], [6, 12]))).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Look:" }] },
      { kind: "paragraph", inlines: [{ kind: "file", index: 0 }] },
      { kind: "code", language: null, text: "code" },
      { kind: "paragraph", inlines: [{ kind: "file", index: 1 }] },
    ]);
  });
});
