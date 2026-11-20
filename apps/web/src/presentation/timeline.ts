// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry, MessageEntry } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";

export type GroupPosition = "single" | "first" | "middle" | "last";

export type TimelineItem =
  | { readonly kind: "divider"; readonly key: string; readonly at: DateTime.Utc }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly entry: MessageEntry;
      readonly position: GroupPosition;
    }
  | { readonly kind: "card"; readonly key: string; readonly entry: Exclude<Entry, MessageEntry> };

/** A quiet stretch longer than this gets a time between the entries around it. */
const DIVIDER_GAP = 15 * 60_000;
/** Consecutive messages from one author closer than this form one group. */
const GROUP_GAP = 5 * 60_000;

const sameAuthor = (a: MessageEntry, b: MessageEntry) =>
  a.author._tag === b.author._tag &&
  (a.author._tag !== "bot" || (b.author._tag === "bot" && a.author.botId === b.author.botId));

/** Entries, oldest first, laid out with times between groups and messages grouped by author. */
export function buildTimeline(entries: ReadonlyArray<Entry>): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previous: Entry | null = null;
  for (const entry of entries) {
    const at = DateTime.toEpochMillis(entry.createdAt);
    const gap = previous === null ? Infinity : at - DateTime.toEpochMillis(previous.createdAt);
    if (gap > DIVIDER_GAP)
      items.push({ kind: "divider", key: `divider-${entry.id}`, at: entry.createdAt });
    if (entry._tag === "message") {
      const last = items.at(-1);
      const joins = last?.kind === "message" && gap <= GROUP_GAP && sameAuthor(last.entry, entry);
      if (joins) {
        items[items.length - 1] = {
          ...last,
          position: last.position === "single" ? "first" : "middle",
        };
      }
      items.push({ kind: "message", key: entry.id, entry, position: joins ? "last" : "single" });
    } else {
      items.push({ kind: "card", key: entry.id, entry });
    }
    previous = entry;
  }
  return items;
}
