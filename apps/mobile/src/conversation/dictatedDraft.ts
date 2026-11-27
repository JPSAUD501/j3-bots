// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention, HeardWords } from "@j3-bots/client-runtime";
import { followFieldEdit, placeHeard } from "@j3-bots/client-runtime/presentation";

/**
 * The draft as dictation began: what Back puts back, and what the words go
 * into, replacing the selection `start` to `end` (the caret, when collapsed).
 */
export interface DictationOrigin {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  readonly start: number;
  readonly end: number;
}

/** The draft with what was heard in it. */
export interface DictatedDraft {
  readonly text: string;
  /** The origin's mentions, moved past the words, without any the words replaced. */
  readonly mentions: ReadonlyArray<DraftMention>;
  /** The words still open to change, `[start, end)`, which the field draws lighter; null when none are. */
  readonly open: readonly [number, number] | null;
  /** Where the caret goes: after the words. */
  readonly caret: number;
}

/** The origin with its selection inside its text, as a draft changed elsewhere may leave it. */
export const originOf = (
  draft: { readonly text: string; readonly mentions: ReadonlyArray<DraftMention> },
  [start, end]: readonly [number, number],
): DictationOrigin => {
  const from = Math.min(start, end, draft.text.length);
  return { ...draft, start: from, end: Math.max(from, Math.min(end, draft.text.length)) };
};

/** `origin` with `heard` where its selection was (`placeHeard`), and its mentions followed there. */
export const dictatedDraft = (origin: DictationOrigin, heard: HeardWords): DictatedDraft => {
  const placed = placeHeard(origin, heard);
  return {
    text: placed.text,
    mentions: followFieldEdit(
      {
        _tag: "change",
        before: origin.text,
        after: placed.text,
        over: origin.start < origin.end ? [origin.start, origin.end] : null,
        written: null,
        caret: placed.tentative,
      },
      origin.mentions,
    ),
    open: placed.tentative > placed.committed ? [placed.committed, placed.tentative] : null,
    caret: placed.tentative,
  };
};
