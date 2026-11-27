// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the server does for entries, done by hand for the sample: numbering
 * them in order, cutting them down to a roster preview and setting the
 * operator's reaction. Development only.
 */
import {
  EntryOrder,
  entryText,
  foldEnding,
  PREVIEW_LENGTH,
  type Entry,
  type EntryPreview,
  type Reaction,
  type ReactionEmoji,
} from "@j3-bots/contracts";

type WithoutOrder<T> = T extends unknown ? Omit<T, "order"> : never;

/** An entry before the server has given it its place. */
export type DraftEntry = WithoutOrder<Entry>;

/** Numbers drafts in the order given, from `first` on. */
export const ordered = (drafts: ReadonlyArray<DraftEntry>, first = 0): Entry[] =>
  drafts.map((draft, index) => ({ ...draft, order: EntryOrder.make(first + index) }));

export const previewOf = (entry: Entry): EntryPreview => ({
  entryId: entry.id,
  order: entry.order,
  kind: entry._tag,
  author: entry.author,
  text: entryText(entry).slice(0, PREVIEW_LENGTH),
  recipientId: entry._tag === "handoff" ? entry.recipientId : null,
  step: null,
  ending: foldEnding(entry),
  notice: entry._tag === "notice" ? entry.notice : null,
  createdAt: entry.createdAt,
});

/**
 * A message's reactions once the operator's is set to `emoji`, or taken off
 * with `null`: as on a server, a changed reaction keeps its place and a new
 * one comes last.
 */
export const withOwnReaction = (
  reactions: ReadonlyArray<Reaction>,
  emoji: ReactionEmoji | null,
): ReadonlyArray<Reaction> => {
  if (emoji === null) return reactions.filter((r) => r.by._tag !== "operator");
  const mine: Reaction = { emoji, by: { _tag: "operator" } };
  return reactions.some((r) => r.by._tag === "operator")
    ? reactions.map((r) => (r.by._tag === "operator" ? mine : r))
    : [...reactions, mine];
};
