// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Entry, type EntryPreview, PREVIEW_LENGTH } from "@j3-bots/contracts";

/** What the roster shows of an entry: its first line of text, cut short. */
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
    text: text.slice(0, PREVIEW_LENGTH),
    createdAt: entry.createdAt,
  };
};
