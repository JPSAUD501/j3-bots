// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Entry,
  type EntryPreview,
  entryText,
  foldEnding,
  PREVIEW_LENGTH,
  type WorkStep,
} from "@j3-bots/contracts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut to at most `length` UTF-16 units, the unit a string's length
 * counts, between two characters as a reader sees them: an emoji, or a letter
 * with its accents, is kept whole or left out.
 */
export const cut = (text: string, length: number): string => {
  if (text.length <= length) return text;
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (end + segment.length > length) break;
    end += segment.length;
  }
  return text.slice(0, end);
};

/**
 * What the roster shows of an entry: its text, cut short; a notice's own
 * words; and for a work fold, `step`, the step that says what it did, and
 * how its turn ended.
 */
export const previewOf = (entry: Entry, step: WorkStep | null): EntryPreview => ({
  entryId: entry.id,
  order: entry.order,
  kind: entry._tag,
  author: entry.author,
  text: cut(entryText(entry), PREVIEW_LENGTH),
  recipientId: entry._tag === "handoff" ? entry.recipientId : null,
  step:
    entry._tag === "work-fold" && step !== null
      ? {
          kind: step.kind,
          tool: step.tool,
          label: step.label,
          ...(step.skill === undefined ? {} : { skill: step.skill }),
        }
      : null,
  ending: foldEnding(entry),
  notice: entry._tag === "notice" ? entry.notice : null,
  createdAt: entry.createdAt,
});
