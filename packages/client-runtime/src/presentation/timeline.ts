// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  Entry,
  EntryId,
  EntryOrder,
  HandoffEntry,
  MessageEntry,
  ReceivedEntry,
  RoutineChangeEntry,
} from "@j3-bots/contracts";
import type { ConversationItem, OutgoingMessage } from "../stores/Conversations.ts";
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
  | { readonly kind: "card"; readonly key: string; readonly entry: Exclude<Entry, MessageEntry> }
  /**
   * An entry, or a notice, of a kind added after this build: one line saying
   * it needs a newer version of the app, in the entry's place.
   */
  | {
      readonly kind: "unknown";
      readonly key: string;
      readonly id: EntryId;
      readonly order: EntryOrder;
    };

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

/** The entry as this build knows it, or null when its kind, or its notice's, came after it. */
const known = (
  entry: Exclude<ReceivedEntry, MessageEntry>,
): Exclude<Entry, MessageEntry> | null => {
  switch (entry._tag) {
    case "unknown":
      return null;
    case "notice": {
      const { notice } = entry;
      return notice._tag === "unknown" ? null : { ...entry, notice };
    }
    default:
      return entry;
  }
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
      const card = known(entry);
      if (card === null) items.push({ kind: "unknown", key, id: entry.id, order: entry.order });
      else if (card._tag === "routine-change") placeRoutineChange(items, key, card);
      else items.push({ kind: "card", key, entry: card });
    }
    previous = entry;
  }
  return items;
}

const sameAuthorOf = (a: RoutineChangeEntry, b: RoutineChangeEntry) =>
  a.author._tag === b.author._tag &&
  (a.author._tag !== "bot" || (b.author._tag === "bot" && a.author.botId === b.author.botId));

/**
 * A routine change, folded into the one before it when both change the same
 * routine, by the same author, in a run of routine changes nothing else
 * breaks: a bot setting up its routines leaves one card for each, not one
 * for every save. The card shows the latest change, with the routine's name
 * and trigger as that change saved them, except that one created in the run
 * and then only edited still reads as created. It stays where the run's first
 * change of that routine was, under that change's key, so it keeps its
 * element as the run grows.
 */
function placeRoutineChange(items: TimelineItem[], key: string, entry: RoutineChangeEntry) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind !== "card" || item.entry._tag !== "routine-change") break;
    const earlier = item.entry;
    if (earlier.routineId !== entry.routineId || !sameAuthorOf(earlier, entry)) continue;
    const change =
      earlier.change === "created" && entry.change === "updated" ? "created" : entry.change;
    items[index] = { ...item, entry: { ...entry, change } };
    return;
  }
  items.push({ kind: "card", key, entry });
}

/** The other bot of a teammate message: the recipient of one sent, the sender of one received. */
export function handoffPeer(entry: HandoffEntry): BotId {
  return entry.direction === "sent" ? entry.recipientId : entry.author.botId;
}
