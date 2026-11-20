// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry, MessageEntry } from "@j3-bots/contracts";
import type { ConversationItem, OutgoingMessage } from "@j3-bots/client-runtime";
import * as DateTime from "effect/DateTime";

export type GroupPosition = "single" | "first" | "middle" | "last";

/** A message the timeline shows: one the server has, or one still on its way from here. */
export type TimelineMessage = MessageEntry | OutgoingMessage;

export type TimelineItem =
  | { readonly kind: "divider"; readonly key: string; readonly at: DateTime.Utc }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: TimelineMessage;
      readonly position: GroupPosition;
    }
  | { readonly kind: "card"; readonly key: string; readonly entry: Exclude<Entry, MessageEntry> };

/** A quiet stretch longer than this gets a time between the entries around it. */
const DIVIDER_GAP = 15 * 60_000;
/** Consecutive messages from one author closer than this form one group. */
const GROUP_GAP = 5 * 60_000;

/**
 * A message sent from this device is keyed by its command id, outgoing and
 * after its entry arrives, so it stays the same element through the change.
 */
const keyOf = (item: ConversationItem): string =>
  item._tag === "outgoing"
    ? item.commandId
    : item._tag === "message" && item.commandId !== null
      ? item.commandId
      : item.id;

const authorOf = (message: TimelineMessage) =>
  message._tag === "outgoing" ? ({ _tag: "operator" } as const) : message.author;

const sameAuthor = (a: TimelineMessage, b: TimelineMessage) => {
  const first = authorOf(a);
  const second = authorOf(b);
  return (
    first._tag === second._tag &&
    (first._tag !== "bot" || (second._tag === "bot" && first.botId === second.botId))
  );
};

/**
 * A conversation's items, oldest first, laid out with times between groups
 * and messages grouped by author. Messages still on their way come last and
 * join the operator's group like any other.
 */
export function buildTimeline(entries: ReadonlyArray<ConversationItem>): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previous: ConversationItem | null = null;
  for (const entry of entries) {
    const at = DateTime.toEpochMillis(entry.createdAt);
    const gap = previous === null ? Infinity : at - DateTime.toEpochMillis(previous.createdAt);
    const key = keyOf(entry);
    if (gap > DIVIDER_GAP)
      items.push({ kind: "divider", key: `divider-${key}`, at: entry.createdAt });
    if (entry._tag === "message" || entry._tag === "outgoing") {
      const last = items.at(-1);
      const joins = last?.kind === "message" && gap <= GROUP_GAP && sameAuthor(last.message, entry);
      if (joins) {
        items[items.length - 1] = {
          ...last,
          position: last.position === "single" ? "first" : "middle",
        };
      }
      items.push({ kind: "message", key, message: entry, position: joins ? "last" : "single" });
    } else {
      items.push({ kind: "card", key, entry });
    }
    previous = entry;
  }
  return items;
}
