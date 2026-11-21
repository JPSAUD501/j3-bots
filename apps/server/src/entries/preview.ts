// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Entry, type EntryPreview, PREVIEW_LENGTH } from "@j3-bots/contracts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut to at most `length` UTF-16 units, the unit a string's length
 * counts, between two characters as a reader sees them: an emoji, or a letter
 * with its accents, is kept whole or left out.
 */
const cut = (text: string, length: number): string => {
  if (text.length <= length) return text;
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (end + segment.length > length) break;
    end += segment.length;
  }
  return text.slice(0, end);
};

/** What the roster shows of an entry: its text, cut short. */
export const previewOf = (entry: Entry): EntryPreview => {
  const text = (() => {
    switch (entry._tag) {
      case "message":
      case "handoff":
        return entry.text;
      case "question":
        return entry.questions[0].prompt;
      case "approval":
        return entry.action;
      case "secret-request":
        return entry.label;
      case "routine-change":
        return entry.name;
      case "work-fold":
      case "notice":
        return "";
    }
  })();
  return {
    entryId: entry.id,
    kind: entry._tag,
    author: entry.author,
    text: cut(text, PREVIEW_LENGTH),
    createdAt: entry.createdAt,
  };
};
