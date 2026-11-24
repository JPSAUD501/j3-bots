// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, PairBotIds, PairSeq, TeammateMessage, TeammatePair } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { DIVIDER_GAP, GROUP_GAP } from "./grouping.ts";
import type { GroupPosition } from "./timeline.ts";

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
