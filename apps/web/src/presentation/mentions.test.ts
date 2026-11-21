// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention } from "@j3-bots/client-runtime";
import { BotId, Invalid, NotFound } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createI18n } from "../i18n/i18n";
import {
  addressed,
  addresseeOf,
  addresseeLine,
  draggedText,
  type FieldEdit,
  followEdit,
  followInput,
  insertMention,
  type Mentionable,
  type MentionOption,
  mentionedNames,
  mentionedWhoLeft,
  mentionOptions,
  mentionQuery,
  movedOption,
  resendLabel,
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

/** Whom a draft's message asks, as `message.send` takes it. */
const addressedTo = (...draft: Parameters<typeof addressed>) => addressed(...draft)?.mentions;

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
    expect(mentionOptions("an", room)).toEqual([bot(ana), bot(otherAna)]);
    const { text, mentions } = picked("@an", bot(otherAna));
    expect(addressedTo(text, mentions, [ana.id, otherAna.id])).toEqual({
      _tag: "bots",
      ids: [otherAna.id],
    });
  });

  it("asks everyone only for the picked @everyone, not for a bot named Everyone", () => {
    const named = member("everyone-bot", "Everyone");
    const room = [scout, named];
    expect(mentionOptions("every", room)).toEqual([bot(named), everyone]);
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

describe("followInput", () => {
  const { text, mentions } = picked("ask @an", bot(ana));
  /** An edit that left the text as it was, over the selection `[4, 9)`: "@Ana ". */
  const unchanged = (inputType: string | null, data: string | null): FieldEdit => ({
    before: text,
    after: text,
    inputType,
    data,
    selection: [4, 9],
    now: [9, 9],
  });

  it("drops a mention the same text was pasted or typed over, which React reports no change for", () => {
    expect(text).toBe("ask @Ana ");
    expect(followInput(unchanged("insertFromPaste", "@Ana "), mentions, null)).toEqual([]);
    // Some browsers do not tell what was pasted: it still replaced the selection.
    expect(followInput(unchanged("insertFromPaste", null), mentions, null)).toEqual([]);
  });

  it("keeps the mentions through an edit that left the text as it was and did not replace the selection", () => {
    // Text other than the selection's leaves the text as it was only somewhere else.
    expect(followInput(unchanged("insertText", "x"), mentions, null)).toEqual(mentions);
    expect(followInput(unchanged("historyUndo", null), mentions, null)).toEqual(mentions);
  });

  describe("text dragged within the field", () => {
    const first = picked("@an", bot(ana));
    const draft = picked(`${first.text}hi @sc`, bot(scout), first.mentions);
    // "@Scout " dragged to the start.
    const source = [draft.text.indexOf("@Scout"), draft.text.length] as const;
    const dragged = draggedText(draft.text, source, draft.mentions);
    const taken = "@Ana hi ";
    const moved = "@Scout @Ana hi ";
    const drag = (
      before: string,
      after: string,
      inputType: string,
      now: readonly [number, number],
    ): FieldEdit => ({ before, after, inputType, data: null, selection: source, now });

    it("moves the mentions in it, taken out and then dropped in, as Chromium tells it", () => {
      expect(draft.text).toBe("@Ana hi @Scout ");
      const left = followInput(
        drag(draft.text, taken, "deleteByDrag", [8, 8]),
        draft.mentions,
        dragged,
      );
      const dropped = followInput(drag(taken, moved, "insertFromDrop", [0, 7]), left, dragged);
      expect(addressedTo(moved, dropped, ids)).toEqual({ _tag: "bots", ids: [scout.id, ana.id] });
      // The same text dropped in from elsewhere was not picked.
      const elsewhere = followInput(drag(taken, moved, "insertFromDrop", [0, 7]), left, null);
      expect(addressedTo(moved, elsewhere, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
    });

    it("moves the mentions in it when the first edit already sees it moved, as WebKit tells it", () => {
      const first = followInput(
        drag(draft.text, moved, "deleteByDrag", [0, 7]),
        draft.mentions,
        dragged,
      );
      expect(addressedTo(moved, first, ids)).toEqual({ _tag: "bots", ids: [scout.id, ana.id] });
      // The second edit finds the text as it is: nothing is left to follow.
      expect(followInput(drag(moved, moved, "insertFromDrop", [0, 7]), first, dragged)).toEqual(
        first,
      );
    });

    it("drops a mention the text was cut out of, already moved, and keeps the others", () => {
      // "hi @Sc" dragged to the end, as WebKit tells it: Scout's mention is cut, Ana's stays.
      const cut = draggedText(draft.text, [5, 11], draft.mentions);
      const edit: FieldEdit = {
        before: draft.text,
        after: "@Ana out hi @Sc",
        inputType: "deleteByDrag",
        data: null,
        selection: [5, 11],
        now: [9, 15],
      };
      expect(followInput(edit, draft.mentions, cut)).toEqual([draft.mentions[0]]);
    });
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

describe("addressee", () => {
  const en = createI18n("en");
  const nameOf = (botId: BotId) => members.find((one) => one.id === botId)?.name;

  it("says a message for nobody goes to the host, named as it is now", () => {
    expect(addresseeLine(addresseeOf(null, scout.id, nameOf, en), en)).toBe(
      "To the host (now Scout)",
    );
  });

  it("says Send again goes to the host once every member mentioned has left", () => {
    const without = { _tag: "bots", ids: [] } as const;
    expect(resendLabel(addresseeOf(without, scout.id, nameOf, en), en)).toBe(
      "Send to the host (Scout)",
    );
    const someStay = { _tag: "bots", ids: [ana.id] } as const;
    expect(resendLabel(addresseeOf(someStay, scout.id, nameOf, en), en)).toBe("Send to Ana");
  });
});

describe("mentionedNames", () => {
  const nameOf = (botId: BotId) => members.find((one) => one.id === botId)?.name;

  it("highlights whom the message addressed, and no one else", () => {
    expect(mentionedNames({ _tag: "bots", ids: [ana.id] }, [], nameOf)).toEqual(["Ana"]);
    expect(mentionedNames({ _tag: "everyone" }, [], nameOf)).toEqual(["everyone"]);
    expect(mentionedNames(null, [], nameOf)).toEqual([]);
  });

  it("goes by the names the members were picked by, when the message keeps them", () => {
    const labels = [{ botId: ana.id, label: "Ana Prime" }];
    expect(mentionedNames({ _tag: "bots", ids: [ana.id, scout.id] }, labels, nameOf)).toEqual([
      "Ana Prime",
      "Scout",
    ]);
  });
});

describe("movedOption", () => {
  it("wraps at both ends", () => {
    expect(movedOption(0, -1, 4)).toBe(3);
    expect(movedOption(3, 1, 4)).toBe(0);
  });
});
