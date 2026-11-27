// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ConnectorAppRef,
  Entry,
  EntryId,
  EntryOrder,
  MessageEntry,
  ReceivedEntry,
  WorkFoldEntry,
} from "@j3-bots/contracts";
import type { ConversationItem, OutgoingMessage } from "../stores/Conversations.ts";
import * as DateTime from "effect/DateTime";
import {
  type CardEntry,
  type EventLine,
  joinEventLines,
  latestOfLine,
  type NonMessageEntry,
  placeOf,
} from "./eventLine.ts";
import { DIVIDER_GAP, GROUP_GAP } from "./grouping.ts";

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
  /** What the bot asks of the operator, or a notice of something that stopped. */
  | {
      readonly kind: "card";
      readonly key: string;
      readonly entry: CardEntry;
    }
  /**
   * Something that happened, in one quiet line (`EventLine`). It keeps the
   * key of its first entry as later ones join it, so it keeps its element.
   */
  | { readonly kind: "event"; readonly key: string; readonly line: EventLine }
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
   * A connector's app, part of the bot's reply where its call happened
   * (decision 0093). An app an older server kept in a turn's work fold
   * (`WorkFoldEntry.apps`) comes right after that fold's row.
   */
  | {
      readonly kind: "app";
      readonly key: string;
      readonly app: ConnectorAppRef;
      /** The app's entry, or the fold's for an app an older server kept there. */
      readonly id: EntryId;
      readonly order: EntryOrder;
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
    previous = entry;
    const key = keyOf(entry);
    const divider: TimelineItem | null =
      gap > DIVIDER_GAP ? { kind: "divider", key: `divider-${key}`, at: entry.createdAt } : null;
    const card = entry._tag === "message" || entry._tag === "outgoing" ? null : known(entry);
    if (card !== null && card._tag !== "work-fold" && card._tag !== "connector-app") {
      placeOther(items, key, card, divider);
      continue;
    }
    if (divider !== null) items.push(divider);
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
    } else if (card === null)
      items.push({ kind: "unknown", key, id: entry.id, order: entry.order });
    else if (card._tag === "connector-app")
      items.push({ kind: "app", key, app: card.app, id: card.id, order: card.order });
    else {
      items.push({ kind: "work", key, fold: card, live: false });
      for (const app of card.apps) {
        items.push({
          kind: "app",
          key: `${key}-${app.viewId}`,
          app,
          id: card.id,
          order: card.order,
        });
      }
    }
  }
  return items;
}

/**
 * An entry that is neither a message nor a turn's work, after the time
 * `divider` when one is due: a line when it tells something that happened,
 * joined to the line just before it when the two make one (`joinEventLines`),
 * the time then left out; otherwise a card.
 */
function placeOther(
  items: TimelineItem[],
  key: string,
  entry: NonMessageEntry,
  divider: TimelineItem | null,
) {
  const place = placeOf(entry);
  const last = items.at(-1);
  if (place._tag === "line" && last?.kind === "event") {
    const joined = joinEventLines(last.line, place.line, divider !== null);
    if (joined !== null) {
      items[items.length - 1] = { ...last, line: joined };
      return;
    }
  }
  if (divider !== null) items.push(divider);
  items.push(
    place._tag === "card"
      ? { kind: "card", key, entry: place.entry }
      : { kind: "event", key, line: place.line },
  );
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
    case "event":
      return latestOfLine(row.line).order;
    case "work":
      return row.fold?.order ?? null;
    case "app":
    case "unknown":
      return row.order;
  }
}

/**
 * What the bots said after the row keyed `since`, oldest first: after every
 * row when it is null, and nothing once that row is gone. A connector's app
 * shown full screen shows the latest over it (decision 0093).
 */
export function botRepliesAfter(
  rows: ReadonlyArray<TimelineItem>,
  since: string | null,
): ReadonlyArray<MessageEntry> {
  const start = since === null ? 0 : rows.findIndex((row) => row.key === since) + 1;
  if (start === 0 && since !== null) return [];
  return rows
    .slice(start)
    .flatMap((row) =>
      row.kind === "message" && row.message._tag === "message" && row.message.author._tag === "bot"
        ? [row.message]
        : [],
    );
}

/**
 * The order a conversation is read through, given the orders of the entries
 * the operator sees: the highest, wherever its row stands, so a row that
 * carries a later entry than the rows below it, such as a joined line,
 * still reads everything it shows.
 */
export function readThrough(seen: Iterable<EntryOrder | null>): EntryOrder | null {
  let highest: EntryOrder | null = null;
  for (const order of seen)
    if (order !== null && (highest === null || order > highest)) highest = order;
  return highest;
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

/**
 * Where a card is against what its conversation shows: in view, above or
 * below it.
 */
export type CardPlace = "shown" | "above" | "below";

/**
 * Where the card of `entryId` is among `rows`, given the keys of the rows
 * `shown` now; null while there is no such card among them, as once its
 * entry is older than what is loaded, or while nothing is known to show.
 */
export function cardPlace(
  rows: ReadonlyArray<TimelineItem>,
  shown: ReadonlySet<string>,
  entryId: EntryId,
): CardPlace | null {
  const index = rows.findIndex((row) => row.kind === "card" && row.entry.id === entryId);
  const card = rows[index];
  if (card === undefined || shown.size === 0) return null;
  if (shown.has(card.key)) return "shown";
  const first = rows.findIndex((row) => shown.has(row.key));
  return first !== -1 && index < first ? "above" : "below";
}
