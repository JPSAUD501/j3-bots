// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Bot, BotId, Invalid, NotFound, type Room, RoomId } from "@j3-bots/contracts";
import { at, bot as fixture } from "../../test/fixtures.ts";
import { describe, expect, it } from "vite-plus/test";
import type { DraftMention } from "../stores/Drafts.ts";
import {
  addressed,
  conversationMentionables,
  conversationMentionNames,
  followEdit,
  insertMention,
  type Mentionable,
  type MentionOption,
  mentionedNames,
  mentionedWhoLeft,
  mentionOptions,
  mentionQuery,
  movedOption,
  named,
  mentionLabel,
  namedNoLonger,
  standingMentions,
} from "./mentions.ts";

const member = (id: string, name: string) =>
  ({ _tag: "bot", id: BotId.make(id), name }) as const satisfies Mentionable;
const ana = member("ana", "Ana");
const anaLima = member("ana-lima", "Ana Lima");
const scout = member("scout", "Scout");
const joao = member("joao", "João");
const members = [scout, ana, anaLima, joao];
const launch = { _tag: "room", id: RoomId.make("launch"), name: "Launch" } as const;
const ids = members.map((one) => one.id);

const bot = ({ id, name }: { id: BotId; name: string }): MentionOption => ({
  _tag: "bot",
  id,
  name,
});
const everyone: MentionOption = { _tag: "everyone" };

/** Whom a draft's message asks, as `message.send` takes it. */
const addressedTo = (...draft: Parameters<typeof addressed>) => addressed(...draft)?.mentions;

/** What the operator ends up with after typing `typed` and picking `option` at its end. */
function picked(typed: string, option: MentionOption, mentions: ReadonlyArray<DraftMention> = []) {
  const query = mentionQuery(typed, typed.length, mentions);
  if (query === null) throw new Error(`No mention is being typed in "${typed}"`);
  return insertMention(typed, typed.length, mentions, query, option);
}

describe("standingMentions", () => {
  it("is the picks that address anyone, in order, placed in the draft as it is", () => {
    const first = picked("  @an", bot(ana));
    const second = picked(`${first.text}and @sc`, bot(scout), first.mentions);
    expect(second.text).toBe("  @Ana and @Scout ");
    expect(standingMentions(second.text, second.mentions.toReversed())).toEqual([
      { _tag: "bot", botId: ana.id, label: "Ana", position: 2 },
      { _tag: "bot", botId: scout.id, label: "Scout", position: 11 },
    ]);
    // Run into a word, a pick stays in the draft but addresses nobody, so it is no chip.
    const edited = "  @Anas and @Scout ";
    const kept = followEdit(second.text, edited, { replaced: null, caret: 7 }, second.mentions);
    expect(kept).toHaveLength(2);
    expect(standingMentions(edited, kept)).toEqual([
      { _tag: "bot", botId: scout.id, label: "Scout", position: 12 },
    ]);
  });
});

describe("addressed", () => {
  it("is who the operator picked, in the order written, each once", () => {
    const first = picked("@sc", bot(scout));
    const second = picked(`${first.text}then @an`, bot(ana), first.mentions);
    const third = picked(`${second.text}and @sc`, bot(scout), second.mentions);
    expect(third.text).toBe("@Scout then @Ana and @Scout ");
    expect(addressedTo(third.text, third.mentions, ids)).toEqual({
      _tag: "bots",
      ids: [scout.id, ana.id],
    });
  });

  it("is nobody for a name typed rather than picked", () => {
    expect(addressedTo("@Ana and @everyone, look", [], ids)).toBeUndefined();
  });

  it("is nobody for a mention that ends up in code", () => {
    const inline = picked("`ask @an", bot(ana));
    expect(addressedTo(inline.text, inline.mentions, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
    expect(addressedTo(`${inline.text}\``, inline.mentions, ids)).toBeUndefined();
    const fenced = picked("```\n@an", bot(ana));
    expect(addressedTo(`${fenced.text}\n\`\`\``, fenced.mentions, ids)).toBeUndefined();
  });

  it("judges code on the text as sent, trimmed", () => {
    // Indented, the fence is none in the draft; trimmed as it is sent, it is one.
    const indented = picked("    ```\n@an", bot(ana));
    expect(addressedTo(`${indented.text}\n\`\`\``, indented.mentions, ids)).toBeUndefined();
    const spaced = picked("  @an", bot(ana));
    expect(addressedTo(spaced.text, spaced.mentions, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
  });

  it("stops counting a mention once its token is edited", () => {
    const { text, mentions } = picked("@an", bot(anaLima));
    expect(text).toBe("@Ana Lima ");
    const edited = "@Ana Lma ";
    const place = { replaced: null, caret: 7 };
    expect(addressedTo(edited, followEdit(text, edited, place, mentions), ids)).toBeUndefined();
    // A name run on into another word is not the name picked either.
    expect(addressedTo("@Ana Limas", mentions, ids)).toBeUndefined();
  });

  it("follows the member picked through a rename, and drops one who left the room", () => {
    const { text, mentions } = picked("@sc", bot(scout));
    const renamed = [member("scout", "Scout Prime")];
    expect(
      addressedTo(
        text,
        mentions,
        renamed.map((one) => one.id),
      ),
    ).toEqual({
      _tag: "bots",
      ids: [scout.id],
    });
    expect(addressedTo(text, mentions, [ana.id, joao.id])).toBeUndefined();
  });

  it("mentions the one picked of two members with the same name", () => {
    const otherAna = member("ana-2", "Ana");
    const room = [ana, otherAna];
    expect(mentionOptions("an", room, true)).toEqual([bot(ana), bot(otherAna)]);
    const { text, mentions } = picked("@an", bot(otherAna));
    expect(addressedTo(text, mentions, [ana.id, otherAna.id])).toEqual({
      _tag: "bots",
      ids: [otherAna.id],
    });
  });

  it("asks everyone only for the picked @everyone, not for a bot named Everyone", () => {
    const named = member("everyone-bot", "Everyone");
    const room = [scout, named];
    expect(mentionOptions("every", room, true)).toEqual([bot(named), everyone]);
    const theBot = picked("@every", bot(named));
    expect(addressedTo(theBot.text, theBot.mentions, [scout.id, named.id])).toEqual({
      _tag: "bots",
      ids: [named.id],
    });
    const all = picked("@sc", bot(scout));
    const both = picked(`${all.text}@ev`, everyone, all.mentions);
    expect(addressedTo(both.text, both.mentions, [scout.id, named.id])).toEqual({
      _tag: "everyone",
    });
  });
});

describe("addressed labels", () => {
  it("names each member by the pick that addressed it, not one left in code", () => {
    const text = "`@Ana` was renamed, so @Ana Prime please";
    const inCode: DraftMention = { _tag: "bot", botId: ana.id, label: "Ana", position: 1 };
    const counted: DraftMention = {
      _tag: "bot",
      botId: ana.id,
      label: "Ana Prime",
      position: text.indexOf("@Ana Prime"),
    };
    expect(addressed(text, [inCode, counted], ids)).toEqual({
      mentions: { _tag: "bots", ids: [ana.id] },
      labels: [{ botId: ana.id, label: "Ana Prime" }],
    });
  });

  it("finds no mention in a link, nor in code a link runs up to", () => {
    const text = "https://example.test/` note @Ana `";
    const mention: DraftMention = {
      _tag: "bot",
      botId: ana.id,
      label: "Ana",
      position: text.indexOf("@Ana"),
    };
    expect(addressed(text, [mention], ids)).toBeUndefined();
    const linked = "https://example.test/(@Ana";
    const inLink: DraftMention = { ...mention, position: linked.indexOf("@Ana") };
    expect(addressed(linked, [inLink], ids)).toBeUndefined();
  });
});

describe("followEdit", () => {
  const { text, mentions } = picked("ask @an", bot(ana));

  it("moves a mention with text written or pasted before it", () => {
    const pasted = `Hi. @Scout said so. ${text}`;
    const moved = followEdit(
      text,
      pasted,
      { replaced: null, caret: pasted.length - text.length },
      mentions,
    );
    expect(moved).toEqual([{ ...mentions[0], position: 24 }]);
    // Pasted text that only reads like a mention addresses nobody.
    expect(addressedTo(pasted, moved, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
  });

  it("moves a mention when an @ is typed right before its own", () => {
    const at = picked("@an", bot(ana));
    const typed = `@${at.text}`;
    expect(followEdit(at.text, typed, { replaced: null, caret: 1 }, at.mentions)).toEqual([
      { ...at.mentions[0], position: 1 },
    ]);
  });

  it("drops a mention the edit cut through", () => {
    expect(followEdit(text, "ask @A", { replaced: null, caret: 6 }, mentions)).toEqual([]);
  });

  it("drops a mention pasted over, though the text pasted starts with the same name", () => {
    // "@Ana " selected and "@Ana, hi " pasted in its place.
    const pasted = "ask @Ana, hi ";
    expect(followEdit(text, pasted, { replaced: [4, 9], caret: 13 }, mentions)).toEqual([]);
    // Text pasted over a selection after the mention leaves it standing.
    // The same text pasted over it ends it too: what was pasted was not picked.
    expect(followEdit(text, text, { replaced: [4, 9], caret: 9 }, mentions)).toEqual([]);
    const after = "ask @Ana and you";
    expect(followEdit(`${text}me`, after, { replaced: [9, 11], caret: 16 }, mentions)).toEqual(
      mentions,
    );
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
    expect(mentionOptions("li", members, true)).toEqual([bot(anaLima)]);
    expect(mentionOptions("ana l", members, true)).toEqual([bot(anaLima)]);
    expect(mentionOptions("", members, true)).toEqual([...members.map(bot), everyone]);
    expect(mentionOptions("EV", members, true)).toEqual([everyone]);
  });

  it("matches whatever the case and accents, composed or decomposed", () => {
    expect(mentionOptions("joa", members, true)).toEqual([bot(joao)]);
    expect(mentionOptions("JOÃ".normalize("NFD"), members, true)).toEqual([bot(joao)]);
    expect(mentionOptions("joã", [member("joao", "João")], true)).toEqual([
      bot(member("joao", "João")),
    ]);
  });
});

describe("mentionOptions in a bot's conversation", () => {
  it("offers bots and rooms, and never everyone", () => {
    const candidates = [scout, launch];
    expect(mentionOptions("", candidates, false)).toEqual([bot(scout), launch]);
    expect(mentionOptions("lau", candidates, false)).toEqual([launch]);
    expect(mentionOptions("ev", candidates, false)).toEqual([]);
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

  it("puts the caret past a space after the name, and before a new line", () => {
    const spaced = "@an next";
    const query = mentionQuery(spaced, 3, []);
    if (query === null) throw new Error("No query");
    expect(insertMention(spaced, 3, [], query, bot(ana))).toMatchObject({
      text: "@Ana next",
      caret: 5,
    });
    const lines = "@an\nnext";
    expect(insertMention(lines, 3, [], query, bot(ana))).toMatchObject({
      text: "@Ana\nnext",
      caret: 4,
    });
  });

  it("picks quickly at the start of a very long pasted line", () => {
    const line = `@${"a".repeat(100_000)}`;
    const query = mentionQuery(line, 1, []);
    if (query === null) throw new Error("No query");
    const started = performance.now();
    const { caret } = insertMention(line, 1, [], query, bot(ana));
    expect(performance.now() - started).toBeLessThan(500);
    expect(caret).toBe(5);
  });

  it("moves the mentions after it", () => {
    const later = picked("x @sc", bot(scout));
    const query = mentionQuery(`@an${later.text}`, 3, later.mentions);
    if (query === null) throw new Error("No query");
    const shifted = later.mentions.map((one) => ({ ...one, position: one.position + 3 }));
    const { text, mentions } = insertMention(`@an${later.text}`, 3, shifted, query, bot(ana));
    expect(text).toBe("@Ana x @Scout ");
    expect(addressedTo(text, mentions, ids)).toEqual({ _tag: "bots", ids: [ana.id, scout.id] });
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

describe("mentionedNames", () => {
  const nameOf = (botId: BotId) => members.find((one) => one.id === botId)?.name;

  it("highlights whom the message addressed, and no one else", () => {
    expect(mentionedNames({ _tag: "bots", ids: [ana.id] }, [], nameOf)).toEqual([
      { name: "Ana", of: { _tag: "bot", botId: ana.id } },
    ]);
    expect(mentionedNames({ _tag: "everyone" }, [], nameOf)).toEqual([
      { name: "everyone", of: null },
    ]);
    expect(mentionedNames(null, [], nameOf)).toEqual([]);
  });

  it("goes by the names the members were picked by, when the message keeps them", () => {
    const labels = [{ botId: ana.id, label: "Ana Prime" }];
    expect(mentionedNames({ _tag: "bots", ids: [ana.id, scout.id] }, labels, nameOf)).toEqual([
      { name: "Ana Prime", of: { _tag: "bot", botId: ana.id } },
      { name: "Scout", of: { _tag: "bot", botId: scout.id } },
    ]);
  });

  it("keeps the name a deleted member was picked by, and highlights it without one", () => {
    const gone = BotId.make("gone");
    const labels = [{ botId: gone, label: "Wren" }];
    expect(mentionedNames({ _tag: "bots", ids: [gone] }, labels, nameOf)).toEqual([
      { name: "Wren", of: { _tag: "bot", botId: gone } },
    ]);
    expect(mentionedNames({ _tag: "bots", ids: [gone] }, [], nameOf)).toEqual([]);
  });
});

describe("movedOption", () => {
  it("wraps at both ends", () => {
    expect(movedOption(0, -1, 4)).toBe(3);
    expect(movedOption(3, 1, 4)).toBe(0);
  });
});

describe("conversationMentionables", () => {
  const fields = { pinned: false, hidden: true, createdAt: at("2026-11-01T00:00:00Z") };
  const active = (name: string, ...members: ReadonlyArray<Bot>): Room => ({
    ...fields,
    id: RoomId.make(name.toLowerCase()),
    name,
    status: "active",
    members: members.map((one) => one.id),
    work: "none",
    forceStop: false,
    answering: [],
    memberWork: [],
  });

  it("offers the other bots, hidden too, then the rooms the bot is in that take messages", () => {
    const ana = fixture("Ana");
    const bia = fixture("Bia", undefined, { hidden: true });
    const cris = fixture("Cris");
    const archived: Room = {
      ...fields,
      id: RoomId.make("old"),
      name: "Old",
      status: "archived",
      members: [ana.id, bia.id],
      archivedAt: at("2026-11-02T00:00:00Z"),
    };
    const rooms = [active("Launch", ana, bia), active("Ops", bia, cris), archived];
    expect(conversationMentionables(ana.id, [ana, bia, cris], rooms)).toEqual([
      { _tag: "bot", id: bia.id, name: "Bia" },
      { _tag: "bot", id: cris.id, name: "Cris" },
      { _tag: "room", id: RoomId.make("launch"), name: "Launch" },
    ]);
  });
});

describe("named", () => {
  const candidates = [scout, ana, launch];

  it("sends each bot and room picked that stands, once, with the names they were picked by", () => {
    const first = picked("@sc", bot(scout));
    const second = picked(`${first.text}ask @lau`, launch, first.mentions);
    const third = picked(`${second.text}and @sc`, bot(scout), second.mentions);
    expect(named(third.text, third.mentions, candidates)).toEqual({
      conversationMentions: [
        { _tag: "bot", botId: scout.id },
        { _tag: "room", roomId: launch.id },
      ],
      labels: [
        { botId: scout.id, label: "Scout" },
        { roomId: launch.id, label: "Launch" },
      ],
    });
  });

  it("leaves out what is no longer offered, and is undefined when nothing stands", () => {
    const pick = picked("tell @lau", launch);
    expect(named(pick.text, pick.mentions, [scout])).toBeUndefined();
    expect(named("tell @Launch", [], candidates)).toBeUndefined();
  });
});

describe("conversationMentionNames", () => {
  it("highlights each by the name it was picked by, else by its name now", () => {
    const mentions = [
      { _tag: "bot", botId: ana.id },
      { _tag: "room", roomId: launch.id },
    ] as const;
    const nameOf = () => "Now";
    expect(
      conversationMentionNames(mentions, [{ roomId: launch.id, label: "Launch" }], nameOf),
    ).toEqual([
      { name: "Now", of: mentions[0] },
      { name: "Launch", of: mentions[1] },
    ]);
    expect(conversationMentionNames(undefined, [], nameOf)).toEqual([]);
  });
});

describe("mentionLabel", () => {
  const room = { _tag: "room", roomId: launch.id } as const;
  const now = () => "Launch week";

  it("names a mention by the name it was picked by, else by its name now", () => {
    expect(mentionLabel(room, [{ roomId: launch.id, label: "Launch" }], now)).toBe("Launch");
    // A bot's label with the same id names no room.
    expect(mentionLabel(room, [{ botId: BotId.make("launch"), label: "Lau" }], now)).toBe(
      "Launch week",
    );
    expect(mentionLabel(room, [], () => undefined)).toBeUndefined();
  });
});

describe("namedNoLonger", () => {
  const refused = { _tag: "refused", error: new Invalid({ reason: "mentions" }) } as const;
  const mentions = [
    { _tag: "bot", botId: ana.id },
    { _tag: "room", roomId: launch.id },
  ] as const;

  it("drops from a refused message what `@` no longer offers there", () => {
    expect(namedNoLonger(refused, mentions, [ana])).toEqual({
      gone: [{ _tag: "room", roomId: launch.id }],
      without: { conversationMentions: [{ _tag: "bot", botId: ana.id }] },
    });
  });

  it("is null for another refusal, or when everything mentioned is still offered", () => {
    const gone = { _tag: "refused", error: new NotFound({ resource: "bot" }) } as const;
    expect(namedNoLonger(gone, mentions, [ana])).toBeNull();
    expect(namedNoLonger(refused, mentions, [ana, launch])).toBeNull();
  });
});
