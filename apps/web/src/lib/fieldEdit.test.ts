// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention } from "@j3-bots/client-runtime";
import {
  addressed,
  draggedText,
  insertMention,
  type Mentionable,
  type MentionOption,
  mentionQuery,
} from "@j3-bots/client-runtime/presentation";
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type FieldInput, followFieldInput } from "./fieldEdit";

/** A bot the draft's room can mention. */
const member = (id: string, name: string) =>
  ({ _tag: "bot", id: BotId.make(id), name }) as const satisfies Mentionable;
const ana = member("ana", "Ana");
const scout = member("scout", "Scout");
const ids = [scout.id, ana.id];

/** Whom a draft's message asks, as `message.send` takes it. */
const addressedTo = (...draft: Parameters<typeof addressed>) => addressed(...draft)?.mentions;

/** What the operator ends up with after typing `typed` and picking `option` at its end. */
function picked(typed: string, option: MentionOption, mentions: ReadonlyArray<DraftMention> = []) {
  const query = mentionQuery(typed, typed.length, mentions);
  if (query === null) throw new Error(`No mention is being typed in "${typed}"`);
  return insertMention(typed, typed.length, mentions, query, option);
}

describe("followFieldInput", () => {
  const { text, mentions } = picked("ask @an", ana);
  /** An edit that left the text as it was, over the selection `[4, 9)`: "@Ana ". */
  const unchanged = (inputType: string | null, data: string | null): FieldInput => ({
    before: text,
    after: text,
    inputType,
    data,
    selection: [4, 9],
    now: [9, 9],
  });

  it("drops a mention the same text was pasted or typed over, which React reports no change for", () => {
    expect(text).toBe("ask @Ana ");
    expect(followFieldInput(unchanged("insertFromPaste", "@Ana "), mentions, null)).toEqual([]);
    // Some browsers do not tell what was pasted: it still replaced the selection.
    expect(followFieldInput(unchanged("insertFromPaste", null), mentions, null)).toEqual([]);
  });

  it("keeps the mentions through an edit that left the text as it was and did not replace the selection", () => {
    // Text other than the selection's leaves the text as it was only somewhere else.
    expect(followFieldInput(unchanged("insertText", "x"), mentions, null)).toEqual(mentions);
    expect(followFieldInput(unchanged("historyUndo", null), mentions, null)).toEqual(mentions);
  });

  it("keeps a pick through an undo made with all the text selected", () => {
    const draft = picked("@an", ana);
    const typed = `${draft.text}hello`;
    const edit: FieldInput = {
      before: typed,
      after: draft.text,
      inputType: "historyUndo",
      data: null,
      // Everything was selected before the undo, but the undo did not replace it.
      selection: [0, typed.length],
      now: [draft.text.length, draft.text.length],
    };
    expect(followFieldInput(edit, draft.mentions, null)).toEqual(draft.mentions);
  });

  describe("text dragged within the field", () => {
    const first = picked("@an", ana);
    const draft = picked(`${first.text}hi @sc`, scout, first.mentions);
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
    ): FieldInput => ({ before, after, inputType, data: null, selection: source, now });

    it("moves the mentions in it, taken out and then dropped in, as Chromium tells it", () => {
      expect(draft.text).toBe("@Ana hi @Scout ");
      const left = followFieldInput(
        drag(draft.text, taken, "deleteByDrag", [8, 8]),
        draft.mentions,
        dragged,
      );
      const dropped = followFieldInput(drag(taken, moved, "insertFromDrop", [0, 7]), left, dragged);
      expect(addressedTo(moved, dropped, ids)).toEqual({ _tag: "bots", ids: [scout.id, ana.id] });
      // The same text dropped in from elsewhere was not picked.
      const elsewhere = followFieldInput(drag(taken, moved, "insertFromDrop", [0, 7]), left, null);
      expect(addressedTo(moved, elsewhere, ids)).toEqual({ _tag: "bots", ids: [ana.id] });
    });

    it("moves the mentions in it when the first edit already sees it moved, as WebKit tells it", () => {
      const first = followFieldInput(
        drag(draft.text, moved, "deleteByDrag", [0, 7]),
        draft.mentions,
        dragged,
      );
      expect(addressedTo(moved, first, ids)).toEqual({ _tag: "bots", ids: [scout.id, ana.id] });
      // The second edit finds the text as it is: nothing is left to follow.
      expect(
        followFieldInput(drag(moved, moved, "insertFromDrop", [0, 7]), first, dragged),
      ).toEqual(first);
    });

    it("moves two picks of the same name when WebKit tells a move that reads the same", () => {
      const otherAna = member("ana-2", "Ana");
      const first = picked("@an", ana);
      const both = picked(`${first.text}@an`, otherAna, first.mentions);
      expect(both.text).toBe("@Ana @Ana ");
      // The first "@Ana " dragged to the end: the field reads the same, the order is not.
      const source = [0, 5] as const;
      const moving = draggedText(both.text, source, both.mentions);
      const edit: FieldInput = {
        before: both.text,
        after: both.text,
        inputType: "deleteByDrag",
        data: null,
        selection: source,
        now: [5, 10],
      };
      const moved = followFieldInput(edit, both.mentions, moving);
      const routed = [otherAna.id, ana.id];
      expect(addressedTo(both.text, moved, routed)).toEqual({ _tag: "bots", ids: routed });
      // WebKit's second edit finds nothing left to follow.
      const second = followFieldInput({ ...edit, inputType: "insertFromDrop" }, moved, moving);
      expect(second).toEqual(moved);
    });

    it("drops a mention the text was cut out of, already moved, and keeps the others", () => {
      // "hi @Sc" dragged to the end, as WebKit tells it: Scout's mention is cut, Ana's stays.
      const cut = draggedText(draft.text, [5, 11], draft.mentions);
      const edit: FieldInput = {
        before: draft.text,
        after: "@Ana out hi @Sc",
        inputType: "deleteByDrag",
        data: null,
        selection: [5, 11],
        now: [9, 15],
      };
      expect(followFieldInput(edit, draft.mentions, cut)).toEqual([draft.mentions[0]]);
    });
  });
});
