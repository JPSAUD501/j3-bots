// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention } from "@j3-bots/client-runtime";
import { BotId, Invalid, NotFound } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  addressed,
  followEdit,
  insertMention,
  type Mentionable,
  type MentionOption,
  mentionedWhoLeft,
  mentionOptions,
  mentionQuery,
  movedOption,
} from "./mentions";

const member = (id: string, name: string): Mentionable => ({ id: BotId.make(id), name });
const ana = member("ana", "Ana");
const anaLima = member("ana-lima", "Ana Lima");
const scout = member("scout", "Scout");
const joao = member("joao", "João");
const members = [scout, ana, anaLima, joao];
const ids = members.map((one) => one.id);

const bot = ({ id, name }: Mentionable): MentionOption => ({ _tag: "bot", id, name });
const everyone: MentionOption = { _tag: "everyone" };

/** What the operator ends up with after typing `typed` and picking `option` at its end. */
function picked(typed: string, option: MentionOption, mentions: ReadonlyArray<DraftMention> = []) {
  const query = mentionQuery(typed, typed.length, mentions);
  if (query === null) throw new Error(`No mention is being typed in "${typed}"`);
  return insertMention(typed, typed.length, mentions, query, option);
}

describe("addressed", () => {
  it("is who the operator picked, in the order written, each once", () => {
    const first = picked("@sc", bot(scout));
    const second = picked(`${first.text}then @an`, bot(ana), first.mentions);
    const third = picked(`${second.text}and @sc`, bot(scout), second.mentions);
    expect(third.text).toBe("@Scout then @Ana and @Scout ");
    expect(addressed(third.text, third.mentions, ids)).toEqual({
      _tag: "bots",
      ids: [scout.id, ana.id],
    });
  });

  it("is nobody for a name typed rather than picked", () => {
    expect(addressed("@Ana and @everyone, look", [], ids)).toBeUndefined();
  });

  it("is nobody for a mention that ends up in code", () => {
    const inline = picked("`ask @an", bot(ana));
    expect(addressed(inline.text, inline.mentions, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
    expect(addressed(`${inline.text}\``, inline.mentions, ids)).toBeUndefined();
    const fenced = picked("```\n@an", bot(ana));
    expect(addressed(`${fenced.text}\n\`\`\``, fenced.mentions, ids)).toBeUndefined();
  });

  it("stops counting a mention once its token is edited", () => {
    const { text, mentions } = picked("@an", bot(anaLima));
    expect(text).toBe("@Ana Lima ");
    const edited = "@Ana Lma ";
    expect(addressed(edited, followEdit(text, edited, 7, mentions), ids)).toBeUndefined();
    // A name run on into another word is not the name picked either.
    expect(addressed("@Ana Limas", mentions, ids)).toBeUndefined();
  });

  it("follows the member picked through a rename, and drops one who left the room", () => {
    const { text, mentions } = picked("@sc", bot(scout));
    const renamed = [member("scout", "Scout Prime")];
    expect(
      addressed(
        text,
        mentions,
        renamed.map((one) => one.id),
      ),
    ).toEqual({
      _tag: "bots",
      ids: [scout.id],
    });
    expect(addressed(text, mentions, [ana.id, joao.id])).toBeUndefined();
  });

  it("mentions the one picked of two members with the same name", () => {
    const otherAna = member("ana-2", "Ana");
    const room = [ana, otherAna];
    expect(mentionOptions("an", room)).toEqual([bot(ana), bot(otherAna)]);
    const { text, mentions } = picked("@an", bot(otherAna));
    expect(addressed(text, mentions, [ana.id, otherAna.id])).toEqual({
      _tag: "bots",
      ids: [otherAna.id],
    });
  });

  it("asks everyone only for the picked @everyone, not for a bot named Everyone", () => {
    const named = member("everyone-bot", "Everyone");
    const room = [scout, named];
    expect(mentionOptions("every", room)).toEqual([bot(named), everyone]);
    const theBot = picked("@every", bot(named));
    expect(addressed(theBot.text, theBot.mentions, [scout.id, named.id])).toEqual({
      _tag: "bots",
      ids: [named.id],
    });
    const all = picked("@sc", bot(scout));
    const both = picked(`${all.text}@ev`, everyone, all.mentions);
    expect(addressed(both.text, both.mentions, [scout.id, named.id])).toEqual({
      _tag: "everyone",
    });
  });
});

describe("followEdit", () => {
  const { text, mentions } = picked("ask @an", bot(ana));

  it("moves a mention with text written or pasted before it", () => {
    const pasted = `Hi. @Scout said so. ${text}`;
    const moved = followEdit(text, pasted, pasted.length - text.length, mentions);
    expect(moved).toEqual([{ ...mentions[0], position: 24 }]);
    // Pasted text that only reads like a mention addresses nobody.
    expect(addressed(pasted, moved, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
  });

  it("moves a mention when an @ is typed right before its own", () => {
    const at = picked("@an", bot(ana));
    const typed = `@${at.text}`;
    expect(followEdit(at.text, typed, 1, at.mentions)).toEqual([
      { ...at.mentions[0], position: 1 },
    ]);
  });

  it("drops a mention the edit cut through", () => {
    expect(followEdit(text, "ask @A", 6, mentions)).toEqual([]);
  });
});

describe("mentionQuery", () => {
  it("opens after the start, a space or opening punctuation, and runs across spaces", () => {
    expect(mentionQuery("@", 1, [])).toEqual({ start: 0, query: "" });
    expect(mentionQuery("ask (@sc", 8, [])).toEqual({ start: 5, query: "sc" });
    expect(mentionQuery('"@sc', 4, [])).toEqual({ start: 1, query: "sc" });
    expect(mentionQuery("note:@sc", 8, [])).toEqual({ start: 5, query: "sc" });
    expect(mentionQuery("ask @Ana Li", 11, [])).toEqual({ start: 4, query: "Ana Li" });
  });

  it("is none inside an address, on a later line, in code, or on a mention already picked", () => {
    expect(mentionQuery("ana@ex", 6, [])).toBeNull();
    expect(mentionQuery("@an\nok", 6, [])).toBeNull();
    expect(mentionQuery("```\n@an\n```", 7, [])).toBeNull();
    const { text, mentions } = picked("@an", bot(ana));
    expect(mentionQuery(text, text.length, mentions)).toBeNull();
  });
});

describe("mentionOptions", () => {
  it("offers members a word of whose name starts with the query, then everyone", () => {
    expect(mentionOptions("li", members)).toEqual([bot(anaLima)]);
    expect(mentionOptions("ana l", members)).toEqual([bot(anaLima)]);
    expect(mentionOptions("", members)).toEqual([...members.map(bot), everyone]);
    expect(mentionOptions("EV", members)).toEqual([everyone]);
  });

  it("matches whatever the case and accents, composed or decomposed", () => {
    expect(mentionOptions("joa", members)).toEqual([bot(joao)]);
    expect(mentionOptions("JOÃ".normalize("NFD"), members)).toEqual([bot(joao)]);
    expect(mentionOptions("joã", [member("joao", "João")])).toEqual([bot(member("joao", "João"))]);
  });
});

describe("insertMention", () => {
  it("writes the name and a space, and puts the caret after them", () => {
    const text = "ask @an to look";
    const query = mentionQuery(text, 7, []);
    if (query === null) throw new Error("No query");
    const { text: next, caret, mentions } = insertMention(text, 7, [], query, bot(anaLima));
    expect({ next, caret }).toEqual({ next: "ask @Ana Lima to look", caret: 14 });
    expect(mentions).toEqual([{ _tag: "bot", botId: anaLima.id, label: "Ana Lima", position: 4 }]);
  });

  it("replaces a name typed in full, and moves the caret past it", () => {
    const text = "@Ana Lima, the draft";
    const query = mentionQuery(text, 4, []);
    if (query === null) throw new Error("No query");
    expect(insertMention(text, 4, [], query, bot(anaLima))).toMatchObject({ text, caret: 9 });
  });

  it("moves the mentions after it", () => {
    const later = picked("x @sc", bot(scout));
    const query = mentionQuery(`@an${later.text}`, 3, later.mentions);
    if (query === null) throw new Error("No query");
    const shifted = later.mentions.map((one) => ({ ...one, position: one.position + 3 }));
    const { text, mentions } = insertMention(`@an${later.text}`, 3, shifted, query, bot(ana));
    expect(text).toBe("@Ana x @Scout ");
    expect(addressed(text, mentions, ids)).toEqual({ _tag: "bots", ids: [ana.id, scout.id] });
  });
});

describe("mentionedWhoLeft", () => {
  const refused = { _tag: "refused", error: new Invalid({ reason: "mentions" }) } as const;
  const mentions = { _tag: "bots", ids: [ana.id, scout.id] } as const;

  it("names the members a refused message mentions who left, and its mentions without them", () => {
    expect(mentionedWhoLeft(refused, mentions, [scout.id, joao.id])).toEqual({
      left: [ana.id],
      without: { _tag: "bots", ids: [scout.id] },
    });
  });

  it("is null for another refusal, or when every member mentioned is still there", () => {
    const gone = { _tag: "refused", error: new NotFound({ resource: "room" }) } as const;
    expect(mentionedWhoLeft(gone, mentions, [scout.id])).toBeNull();
    expect(mentionedWhoLeft(refused, mentions, [ana.id, scout.id])).toBeNull();
  });
});

describe("movedOption", () => {
  it("wraps at both ends", () => {
    expect(movedOption(0, -1, 4)).toBe(3);
    expect(movedOption(3, 1, 4)).toBe(0);
  });
});
