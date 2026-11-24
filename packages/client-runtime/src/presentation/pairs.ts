// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type EntryId,
  type EntryOrder,
  type HandoffEntry,
  type PairBotIds,
  pairBotIds,
  type PairSeq,
  type TeammateMessage,
  type TeammatePair,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { DIVIDER_GAP, GROUP_GAP } from "./grouping.ts";
import { type GroupPosition, handoffPeer, rowOrder, type TimelineItem } from "./timeline.ts";

/**
 * A pair of bots as one string: what a teammate conversation is opened and
 * kept under, and what its roster row is marked with. Bot ids may hold any
 * character, so the two are written as JSON.
 */
export const pairKeyText = (botIds: PairBotIds): string => `pair:${JSON.stringify(botIds)}`;

/** Whether `botId` is one of the pair. */
export const inPair = (botIds: PairBotIds, botId: BotId): boolean =>
  botIds[0] === botId || botIds[1] === botId;

/** The other bot of a pair `botId` is in. */
export const peerOf = (botIds: PairBotIds, botId: BotId): BotId =>
  botIds[0] === botId ? botIds[1] : botIds[0];

/** A pair in a bot's details: the teammate conversation and the other bot. */
export interface Teammate {
  readonly pair: TeammatePair;
  readonly peer: BotId;
}

/**
 * The teammate conversations a bot's details list, latest first as `pairs`
 * are: every pair the bot is in, with a hidden or deleted teammate's too,
 * which the roster no longer shows.
 */
export const teammatesOf = (
  botId: BotId,
  pairs: ReadonlyArray<TeammatePair>,
): ReadonlyArray<Teammate> =>
  pairs.flatMap((pair) =>
    inPair(pair.botIds, botId) ? [{ pair, peer: peerOf(pair.botIds, botId) }] : [],
  );

// ---------------------------------------------------------------------------
// The teammate conversation

/** A teammate conversation's row, laid out the way a room lays out its messages. */
export type PairTimelineItem =
  | { readonly kind: "divider"; readonly key: string; readonly at: DateTime.Utc }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: TeammateMessage;
      /**
       * Its place in a run of the same bot's messages: the bot's name goes
       * over the first (`single` or `first`), its avatar beside the last
       * (`single` or `last`).
       */
      readonly position: GroupPosition;
    };

/** The key of a message's row, to scroll to the one `reveal` found. */
export const pairMessageKey = (seq: PairSeq): string => `pair-message-${seq}`;

/**
 * A teammate conversation's messages, oldest first, laid out like a room's:
 * a time between quiet stretches, and each bot's consecutive messages
 * grouped under its name.
 */
export function buildPairTimeline(
  messages: ReadonlyArray<TeammateMessage>,
): ReadonlyArray<PairTimelineItem> {
  const items: Array<PairTimelineItem> = [];
  let previous: TeammateMessage | null = null;
  for (const message of messages) {
    const at = DateTime.toEpochMillis(message.createdAt);
    const gap = previous === null ? Infinity : at - DateTime.toEpochMillis(previous.createdAt);
    const key = pairMessageKey(message.seq);
    if (gap > DIVIDER_GAP)
      items.push({ kind: "divider", key: `divider-${key}`, at: message.createdAt });
    const last = items.at(-1);
    const joins =
      last?.kind === "message" && gap <= GROUP_GAP && last.message.from === message.from;
    if (joins) {
      items[items.length - 1] = {
        ...last,
        position: last.position === "single" ? "first" : "middle",
      };
    }
    items.push({ kind: "message", key, message, position: joins ? "last" : "single" });
    previous = message;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Teammate messages in a bot's own conversation

/** One teammate a run of messages was with, and where their conversation opens. */
export interface TeammateRunPair {
  readonly peer: BotId;
  readonly botIds: PairBotIds;
  /** The first card of the run with this teammate: the conversation opens at its message. */
  readonly first: EntryId;
  /** How many of the run's messages were with this teammate. */
  readonly count: number;
}

/**
 * Consecutive teammate messages in one bot's conversation, with nothing else
 * between them, which the conversation shows as one line ("Talked with Wren
 * · 3 messages"). Its line opens the teammate conversation at the run, or a
 * chooser of `pairs` when there are several.
 */
export interface TeammateRun {
  /** The first card's key: the line keeps its element as the run grows. */
  readonly key: string;
  /** Oldest first. */
  readonly entries: readonly [HandoffEntry, ...HandoffEntry[]];
  /** Each teammate, in the order the run first met them. */
  readonly pairs: readonly [TeammateRunPair, ...TeammateRunPair[]];
  /** `sent` when the bot only wrote, `received` when it only heard, `both` otherwise. */
  readonly direction: "sent" | "received" | "both";
  /** Messages that never reached their teammate: `not-delivered` or `stopped`. */
  readonly undelivered: number;
}

/** A conversation's row, with each run of teammate messages one row. */
export type ConversationRow =
  | TimelineItem
  | { readonly kind: "teammates"; readonly key: string; readonly run: TeammateRun };

/** The bot whose conversation a teammate card is in. */
const ownerOf = (entry: HandoffEntry): BotId =>
  entry.direction === "sent" ? entry.author.botId : entry.recipientId;

/** The run `entries` make: consecutive teammate cards, at least one. */
function teammateRun(
  key: string,
  entries: readonly [HandoffEntry, ...HandoffEntry[]],
): TeammateRun {
  const byPeer = new Map<BotId, TeammateRunPair>();
  let sent = 0;
  let undelivered = 0;
  for (const entry of entries) {
    const peer = handoffPeer(entry);
    const known = byPeer.get(peer);
    byPeer.set(
      peer,
      known === undefined
        ? { peer, botIds: pairBotIds(ownerOf(entry), peer), first: entry.id, count: 1 }
        : { ...known, count: known.count + 1 },
    );
    if (entry.direction === "sent") sent += 1;
    if (entry.state === "not-delivered" || entry.state === "stopped") undelivered += 1;
  }
  const [first, ...rest] = byPeer.values();
  if (first === undefined) throw new Error("A run has at least one card");
  return {
    key,
    entries,
    pairs: [first, ...rest],
    direction: sent === entries.length ? "sent" : sent === 0 ? "received" : "both",
    undelivered,
  };
}

const isTeammateCard = (
  row: TimelineItem,
): row is Extract<TimelineItem, { kind: "card" }> & { readonly entry: HandoffEntry } =>
  row.kind === "card" && row.entry._tag === "handoff";

/**
 * A conversation's rows (`buildTimeline`, and `withLiveTurn` after it) with
 * each run of teammate cards, nothing else between them, made one row. A
 * time between two cards of a run goes: the line stands at the run's start.
 */
export function withTeammateRuns(
  rows: ReadonlyArray<TimelineItem>,
): ReadonlyArray<ConversationRow> {
  const out: Array<ConversationRow> = [];
  let run: { readonly key: string; readonly entries: [HandoffEntry, ...HandoffEntry[]] } | null =
    null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined) continue;
    if (isTeammateCard(row)) {
      if (run === null) run = { key: row.key, entries: [row.entry] };
      else run.entries.push(row.entry);
      continue;
    }
    if (run !== null) {
      // A time between two cards of one run is not shown.
      const next =
        row.kind === "divider"
          ? rows.slice(index + 1).find((later) => later.kind !== "divider")
          : undefined;
      if (next !== undefined && isTeammateCard(next)) continue;
      out.push({ kind: "teammates", key: run.key, run: teammateRun(run.key, run.entries) });
      run = null;
    }
    out.push(row);
  }
  if (run !== null)
    out.push({ kind: "teammates", key: run.key, run: teammateRun(run.key, run.entries) });
  return out;
}

/**
 * The order of the newest entry a row shows (`rowOrder`); a run's is its
 * newest card's, so reading through the run reads every card in it.
 */
export function conversationRowOrder(row: ConversationRow): EntryOrder | null {
  if (row.kind !== "teammates") return rowOrder(row);
  return row.run.entries.reduce(
    (newest, entry) => (entry.order > newest ? entry.order : newest),
    row.run.entries[0].order,
  );
}
