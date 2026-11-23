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
  WorkFoldEntry,
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
  | {
      readonly kind: "card";
      readonly key: string;
      readonly entry: Exclude<Entry, MessageEntry | WorkFoldEntry>;
    }
  /**
   * A turn's work: its fold once it has one, and while the turn runs, the
   * line that says what the bot is doing (`live`), which becomes the fold's
   * line when the turn ends (`withLiveTurn`).
   */
  | {
      readonly kind: "work";
      readonly key: string;
      /** Null for a turn under way that has done no work yet. */
      readonly fold: WorkFoldEntry | null;
      readonly live: boolean;
    }
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
      : item._tag === "work-fold" && item.turnStartedAt !== null
        ? turnKey(item.turnStartedAt)
        : item.id;

/**
 * A turn's row, by when it started: the same before its first step, once it
 * has a fold, and after it ends, so the row keeps its element throughout.
 */
export const turnKey = (startedAt: DateTime.Utc): string =>
  `turn-${DateTime.toEpochMillis(startedAt)}`;

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
      else if (card._tag === "work-fold")
        items.push({ kind: "work", key, fold: card, live: false });
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
 * A routine change, folded into the card just before it when that card
 * created or edited the same routine, by the same author, and this change
 * only edits it: a bot setting up a routine leaves one card, not one for
 * every save. The card shows the routine's name and trigger as the latest
 * edit saved them, and keeps reading as created when the run began with its
 * creation. A pause, a resume or a deletion keeps a card of its own, and so
 * does a change that anything, even another routine's change, comes between.
 * The folded card keeps its first key, so it keeps its element as the run
 * grows, and carries the latest entry, so its order is the run's newest.
 */
function placeRoutineChange(items: TimelineItem[], key: string, entry: RoutineChangeEntry) {
  const last = items.at(-1);
  const folds =
    entry.change === "updated" &&
    last?.kind === "card" &&
    last.entry._tag === "routine-change" &&
    (last.entry.change === "created" || last.entry.change === "updated") &&
    last.entry.routineId === entry.routineId &&
    sameAuthorOf(last.entry, entry);
  if (folds) items[items.length - 1] = { ...last, entry: { ...entry, change: last.entry.change } };
  else items.push({ kind: "card", key, entry });
}

/** The order of the entry a row shows; none for a divider or a message still on its way. */
export function rowOrder(row: TimelineItem): EntryOrder | null {
  switch (row.kind) {
    case "divider":
      return null;
    case "message":
      return row.message._tag === "message" ? row.message.order : null;
    case "card":
      return row.entry.order;
    case "work":
      return row.fold?.order ?? null;
    case "unknown":
      return row.order;
  }
}

/**
 * The order a conversation is read through, given the orders of the entries
 * the operator sees: the highest, wherever its row stands, so a row that
 * carries a later entry than the rows below it, such as a folded routine
 * card, still reads everything it shows.
 */
export function readThrough(seen: Iterable<EntryOrder | null>): EntryOrder | null {
  let highest: EntryOrder | null = null;
  for (const order of seen)
    if (order !== null && (highest === null || order > highest)) highest = order;
  return highest;
}

/** The other bot of a teammate message: the recipient of one sent, the sender of one received. */
export function handoffPeer(entry: HandoffEntry): BotId {
  return entry.direction === "sent" ? entry.recipientId : entry.author.botId;
}

/**
 * The rows that arrived at the end of a conversation between two of its
 * renders, by key: those after the newest row it showed before. Earlier
 * rows loaded above, and a row that keeps its key as it changes (a message
 * the server took over from this device), did not arrive. Nothing arrives on
 * the first render, `before` null, so opening a conversation plays nothing.
 */
export function arrivedRows(
  before: ReadonlyArray<string> | null,
  after: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (before === null) return new Set();
  const known = new Set(before);
  // The newest row shown before that is still there; rows past it arrived.
  let start = after.length;
  for (let i = after.length - 1; i >= 0; i--) {
    const key = after[i];
    if (key !== undefined && known.has(key)) break;
    start = i;
  }
  // A conversation that kept none of its rows started again: nothing arrived in it.
  if (start === 0 && before.length > 0) return new Set();
  return new Set(after.slice(start));
}

/** What the rows that arrived at the end of a conversation hold, for whoever follows its end. */
export interface ArrivalCounts {
  /** One of them is a message the operator sent from this device. */
  readonly own: boolean;
  /** Messages others wrote: bots, in a room each member. Cards, notices and times are not counted. */
  readonly others: number;
}

/** Counts what arrived among `rows`, the conversation's rows as they stand. */
export function arrivalCounts(
  rows: ReadonlyArray<TimelineItem>,
  arrived: ReadonlySet<string>,
): ArrivalCounts {
  let own = false;
  let others = 0;
  for (const row of rows) {
    if (row.kind !== "message" || !arrived.has(row.key)) continue;
    const { message } = row;
    if (message._tag === "outgoing") own = true;
    else if (message.author._tag !== "operator") others += 1;
  }
  return { own, others };
}
