// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, EntryId, NonNegativeInt, PositiveInt } from "./base.ts";
import { HandoffState, MessageText, PREVIEW_LENGTH } from "./entry.ts";

/**
 * A teammate message's place among every teammate message on the server:
 * given once, when the message is sent, in the order they were sent, and
 * never given again. A teammate conversation sorts by it, and pages back with
 * it. It says nothing about where the message's cards sit in the two bots'
 * conversations (that is each card's `EntryOrder`).
 */
export const PairSeq = NonNegativeInt.pipe(Schema.brand("PairSeq"));
export type PairSeq = typeof PairSeq.Type;

/**
 * The two bots of a teammate conversation, sorted, which is how one is
 * addressed: there is no id of its own. An id outlives its bot, so a pair
 * may name a deleted bot.
 */
export const PairBotIds = Schema.Tuple([BotId, BotId]).check(
  Schema.makeFilter(
    ([low, high]: readonly [BotId, BotId]) => low < high || "two different bots, sorted",
  ),
);
export type PairBotIds = typeof PairBotIds.Type;

/** The pair two bots make, whichever of them is named first. */
export const pairBotIds = (a: BotId, b: BotId): PairBotIds => (a < b ? [a, b] : [b, a]);

const messageFields = {
  seq: PairSeq,
  from: BotId,
  to: BotId,
  /**
   * The message's card in the sender's conversation (`direction: "sent"`),
   * and in the recipient's (`direction: "received"`): what maps a handoff
   * entry a client holds to the message. Null once that bot is deleted,
   * which takes its conversation with it; never both.
   */
  sentEntryId: Schema.NullOr(EntryId),
  receivedEntryId: Schema.NullOr(EntryId),
  urgent: Schema.Boolean,
  /** Where the message stands, as its cards say (`HandoffEntry.state`). */
  state: HandoffState,
  createdAt: Schema.DateTimeUtc,
};

/**
 * One message a bot sent a teammate, as their teammate conversation lists
 * it. Not an `Entry`: it belongs to no conversation's order and has no read
 * mark. Its `seq` is what a client upserts it by.
 */
export const TeammateMessage = Schema.Struct({ ...messageFields, text: MessageText });
export type TeammateMessage = typeof TeammateMessage.Type;

/** A teammate message as a list of pairs shows it: its text cut to `PREVIEW_LENGTH`. */
export const TeammateMessagePreview = Schema.Struct({
  ...messageFields,
  text: Schema.String.check(Schema.isMaxLength(PREVIEW_LENGTH)),
});
export type TeammateMessagePreview = typeof TeammateMessagePreview.Type;

/**
 * A teammate conversation as a roster row or a bot's details list it: the
 * two bots, the latest message, which is the row's line and time, and how
 * many messages it holds. Only a pair with messages is one.
 */
export const TeammatePair = Schema.Struct({
  botIds: PairBotIds,
  lastMessage: TeammateMessagePreview,
  count: PositiveInt,
});
export type TeammatePair = typeof TeammatePair.Type;
