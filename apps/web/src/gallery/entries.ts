// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the server does for entries, done by hand for the sample: numbering
 * them in order and cutting them down to a roster preview. Development only.
 */
import {
  EntryOrder,
  foldEnding,
  PREVIEW_LENGTH,
  type Entry,
  type EntryPreview,
} from "@j3-bots/contracts";

type WithoutOrder<T> = T extends unknown ? Omit<T, "order"> : never;

/** An entry before the server has given it its place. */
export type DraftEntry = WithoutOrder<Entry>;

/** Numbers drafts in the order given, from `first` on. */
export const ordered = (drafts: ReadonlyArray<DraftEntry>, first = 0): Entry[] =>
  drafts.map((draft, index) => ({ ...draft, order: EntryOrder.make(first + index) }));

function previewText(entry: Entry): string {
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
    case "credential-request":
      return entry.origin;
    case "routine-change":
      return entry.name;
    case "work-fold":
    case "notice":
      return "";
  }
}

export const previewOf = (entry: Entry): EntryPreview => ({
  entryId: entry.id,
  order: entry.order,
  kind: entry._tag,
  author: entry.author,
  text: previewText(entry).slice(0, PREVIEW_LENGTH),
  recipientId: entry._tag === "handoff" ? entry.recipientId : null,
  step: null,
  ending: foldEnding(entry),
  notice: entry._tag === "notice" ? entry.notice : null,
  createdAt: entry.createdAt,
});
