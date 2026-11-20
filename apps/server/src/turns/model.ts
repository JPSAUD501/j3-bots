// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalDecision,
  type BotId,
  EntryId,
  type EntryTarget,
  QuestionAnswers,
  RoomId,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// The shapes the turn machinery shares: audiences, wake payloads, and the rows
// it reads back from the database, decoded like any other boundary.

/**
 * Where a turn's speech goes: the bot's own conversation, or one room. A room
 * audience whose room was deleted keeps `room` with no id: nothing reaches it.
 */
export type Audience =
  | { readonly _tag: "conversation" }
  | { readonly _tag: "room"; readonly roomId: RoomId | null };

export const conversation: Audience = { _tag: "conversation" };

/** The `audience` and `audience_room_id` columns of an audience. */
export const audienceColumns = (audience: Audience) => ({
  audience: audience._tag,
  roomId: audience._tag === "room" ? audience.roomId : null,
});

export const audienceOf = (row: {
  readonly audience: "conversation" | "room";
  readonly audience_room_id: RoomId | null;
}): Audience =>
  row.audience === "conversation" ? conversation : { _tag: "room", roomId: row.audience_room_id };

export const sameAudience = (a: Audience, b: Audience): boolean =>
  a._tag === b._tag && (a._tag === "conversation" || (b._tag === "room" && a.roomId === b.roomId));

/** Where an audience's entries go, if it still has a place. */
export const targetOf = (botId: BotId, audience: Audience): EntryTarget | null =>
  audience._tag === "conversation"
    ? { _tag: "conversation", botId }
    : audience.roomId === null
      ? null
      : { _tag: "room", roomId: audience.roomId };

export const AudienceColumn = Schema.Literals(["conversation", "room"]);

export const WakeKind = Schema.Literals(["user", "room", "bot", "routine", "system"]);
export type WakeKind = typeof WakeKind.Type;

/** Lower is first: the operator, then rooms, teammates, J3 Bots itself and routines. */
export const PRIORITY: { readonly [K in WakeKind]: number } = {
  user: 0,
  room: 1,
  bot: 2,
  system: 3,
  routine: 4,
};

/**
 * What a wake carries, read when its envelope is rendered. The kinds part 2b
 * adds (room, teammate and routine wakes) add their own variants here.
 */
export const WakePayload = Schema.Union([
  /** An operator message, read from its entry. */
  Schema.TaggedStruct("message", { entryId: EntryId }),
  /** The operator's answer to an `ask` card, read from the card. */
  Schema.TaggedStruct("answer", { cardId: EntryId }),
  /** The `user` dispatch this one follows up, whose turn delivered nothing. */
  Schema.TaggedStruct("undelivered", { dispatchId: Schema.String }),
]);
export type WakePayload = typeof WakePayload.Type;

/**
 * What a bot's main session has not seen, reported at the top of its next
 * envelope there. Part 2b writes them: routine runs in side sessions and
 * profile edits.
 */
export const CatchUpNote = Schema.Union([
  Schema.TaggedStruct("routine-delivered", {
    routine: Schema.String,
    at: Schema.DateTimeUtc,
    text: Schema.String,
  }),
  Schema.TaggedStruct("profile-changed", {
    changes: Schema.NonEmptyArray(
      Schema.Struct({ field: Schema.Literals(["name", "title", "job"]), value: Schema.String }),
    ),
  }),
]);
export type CatchUpNote = typeof CatchUpNote.Type;

export const WakeStatus = Schema.Literals([
  "pending",
  "dispatched",
  "finished",
  "cancelled",
  "failed",
]);
export const WakeFailure = Schema.Literals(["rejected", "unresolved", "stopped"]);
export type WakeFailure = typeof WakeFailure.Type;

export const DispatchStatus = Schema.Literals([
  "intended",
  "accepted",
  "delivered",
  "finished",
  "dropped",
  "released",
  "failed",
]);
export type DispatchStatus = typeof DispatchStatus.Type;

/** How long a recovery waits after its `n`th undecided answer: doubling from 2 s to 10 min. */
export const recoveryBackoff = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 * 2 ** Math.max(0, n - 1)), Duration.minutes(10));

/** A recovery that got this many undecided answers fails as `unresolved`. */
export const MAX_INDETERMINATE_ANSWERS = 10;

/** A dispatch older than this fails as `unresolved` instead of being recovered. */
export const RECOVERY_WINDOW = Duration.days(1);

/** A turn with no activity for this long is shown as possibly stalled. */
export const STALL_AFTER = Duration.minutes(10);

/**
 * The operator's answer to an engine request, kept on its card until the
 * request closes: what the card shows once it does.
 */
export const StoredResponse = Schema.Union([
  Schema.TaggedStruct("approval", { decision: ApprovalDecision }),
  Schema.TaggedStruct("question", { answers: QuestionAnswers }),
  Schema.TaggedStruct("dismiss", {}),
]);
export type StoredResponse = typeof StoredResponse.Type;
