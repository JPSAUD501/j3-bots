// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type MentionName, parseMessageText } from "./messageText.ts";

const wren = { name: "Wren", botId: BotId.make("wren") } satisfies MentionName;
const ana = { name: "Ana", botId: BotId.make("ana") } satisfies MentionName;
const anaLima = { name: "Ana Lima", botId: BotId.make("ana-lima") } satisfies MentionName;
const hal = { name: "Hal", botId: BotId.make("hal") } satisfies MentionName;
const everyone = { name: "everyone", botId: null } satisfies MentionName;

const inlinesOf = (text: string, mentionable: ReadonlyArray<MentionName> = []) => {
  const [block] = parseMessageText(text, mentionable);
  return block?.kind === "paragraph" ? block.inlines : [];
};

const mention = ({ name, botId }: MentionName) => ({ kind: "mention", name, botId }) as const;

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
    const otherAna = { name: "Ana", botId: BotId.make("other-ana") } satisfies MentionName;
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
    expect(parseMessageText("Here are the notes.")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Here are the notes." }] },
    ]);
  });

  it("puts a file before the code, link or mention it is placed at, and after one it would split", () => {
    const text = "see `a` https://x.dev @Ana end";
    const [block] = parseMessageText(text, [ana], [4, 8, 24, 30]);
    expect(block).toEqual({
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "see " },
        { kind: "file", index: 0 },
        { kind: "code", text: "a" },
        { kind: "text", text: " " },
        { kind: "file", index: 1 },
        { kind: "link", href: "https://x.dev", text: "https://x.dev" },
        { kind: "text", text: " " },
        mention(ana),
        { kind: "file", index: 2 },
        { kind: "text", text: " end" },
        { kind: "file", index: 3 },
      ],
    });
  });

  it("keeps a file placed at a code block before it, and one inside it after it", () => {
    const text = "Look:\n```\ncode\n```";
    expect(parseMessageText(text, [], [6, 12])).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Look:" }] },
      { kind: "paragraph", inlines: [{ kind: "file", index: 0 }] },
      { kind: "code", language: null, text: "code" },
      { kind: "paragraph", inlines: [{ kind: "file", index: 1 }] },
    ]);
  });
});
