// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EntryId,
  EntryOrder,
  MAX_QUOTE_PASSAGE_LENGTH,
  MAX_QUOTES,
  type MessageQuote,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  passageOf,
  type QuotableMessage,
  quoteRequestOf,
  quoteText,
  replyTo,
  withComment,
  withQuote,
} from "./quotes.ts";

const message = (id: string, text: string): QuotableMessage => ({
  _tag: "message",
  id: EntryId.make(id),
  order: EntryOrder.make(1),
  author: { _tag: "operator" },
  createdAt: DateTime.makeUnsafe("2026-11-20T12:00:00Z"),
  text,
  attachments: [],
  mentions: { _tag: "bots", ids: [] },
  delivery: { _tag: "delivered" },
  commandId: null,
});

const passage = (source: QuotableMessage, words: string): MessageQuote => {
  const start = source.text.indexOf(words);
  const quote = passageOf(source, start, start + words.length);
  if (quote === null || quote === "too-long") throw new Error(`No passage "${words}"`);
  return quote;
};

describe("quotes", () => {
  const plans = message("plans", "Two plans: a quick one, or a careful one with `tests`.");
  const notes = message("notes", "Notes for later.");

  it("keeps one reply, first, and each passage once, up to the most a message takes", () => {
    const added = (quotes: ReadonlyArray<MessageQuote>, quote: MessageQuote) => {
      const next = withQuote(quotes, quote);
      if (next === "full") throw new Error("Full");
      return next;
    };
    const quick = passage(plans, "a quick one");
    const one = added([], quick);
    // The same passage again changes nothing, unless it brings a comment, which it takes in place;
    // quoted again bare, it keeps the comment it has.
    expect(added(one, quick)).toEqual([quick]);
    const remarked = withComment(quick, "  Too fast?  ");
    expect(added([quick, passage(plans, "careful")], remarked)).toEqual([
      remarked,
      passage(plans, "careful"),
    ]);
    expect(added([remarked], quick)).toEqual([remarked]);
    // A reply goes first, and another reply takes its place.
    const replied = added(added(one, replyTo(plans)), replyTo(notes));
    expect(replied).toEqual([replyTo(notes), quick]);
    const full = added(replied, passage(plans, "careful"));
    expect(full).toHaveLength(MAX_QUOTES);
    expect(withQuote(full, passage(plans, "Two"))).toBe("full");
    // A reply still takes the place of the reply when the draft is full.
    expect(added(full, replyTo(plans))[0]).toEqual(replyTo(plans));
  });

  it("comments a passage in the operator's words, trimmed, and never a reply", () => {
    const quick = passage(plans, "a quick one");
    expect(quoteRequestOf(withComment(quick, "  Too fast?\n"))).toEqual({
      entryId: plans.id,
      passage: "a quick one",
      comment: "Too fast?",
    });
    // Spaces alone take the comment off.
    expect(withComment(withComment(quick, "Too fast?"), "  ")).toEqual(quick);
    expect(withComment(replyTo(plans), "Yes")).toEqual(replyTo(plans));
  });

  it("quotes a selection trimmed, and nothing for spaces alone or past the longest passage", () => {
    const start = plans.text.indexOf("a quick");
    expect(passageOf(plans, start - 1, start + "a quick one".length + 1)).toMatchObject({
      quoted: { _tag: "passage", text: "a quick one," },
    });
    expect(passageOf(plans, 3, 4)).toBeNull();
    const long = message("long", "word ".repeat(MAX_QUOTE_PASSAGE_LENGTH));
    expect(passageOf(long, 0, long.text.length)).toBe("too-long");
  });

  it("reads a passage as picked, and a reply's start as its bubble shows it, … where it went on", () => {
    expect(quoteText(passage(plans, "careful one with `tests`"))).toBe("careful one with `tests`");
    const fence = message("fence", "Open the block with ```json\nand close it.");
    expect(quoteText(passage(fence, "```json"))).toBe("```json");
    expect(quoteText(replyTo(plans))).toBe("Two plans: a quick one, or a careful one with tests.");
    const long = message("long", `${"word ".repeat(100)}end`);
    expect(quoteText(replyTo(long))).toMatch(/^word word .*…$/u);
    expect(quoteText(replyTo(notes))).toBe("Notes for later.");
  });
});
