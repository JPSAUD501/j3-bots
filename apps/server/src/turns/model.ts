// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalDecision,
  type BotId,
  EntryId,
  type EntryTarget,
  QuestionAnswers,
  RoomId,
  RoutineId,
  RoutineRunId,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// The shapes the turn machinery shares: row ids, audiences, wake payloads, and
// the rows it reads back from the database, decoded like any other boundary.

/**
 * J3 Bots' own id of a dispatch row, which is also the dispatch's engine key.
 * Branded so it is never mixed with an engine id.
 */
export const DispatchRowId = Schema.String.pipe(Schema.brand("DispatchRowId"));
export type DispatchRowId = typeof DispatchRowId.Type;

/**
 * The order a dispatch was written in: SQLite's serialized writes give every
 * dispatch a higher one than any written before it, and none is reused.
 */
export const DispatchSeq = Schema.Int.pipe(Schema.brand("DispatchSeq"));
export type DispatchSeq = typeof DispatchSeq.Type;

/** J3 Bots' own id of a session row; the engine's id for it is a `SessionId`. */
export const SessionRowId = Schema.String.pipe(Schema.brand("SessionRowId"));
export type SessionRowId = typeof SessionRowId.Type;

/**
 * A broken invariant of the turn machinery: a bug, never a state a caller
 * handles. Raised as a defect.
 */
export class TurnsInvariant extends Schema.TaggedError<TurnsInvariant>()("TurnsInvariant", {
  invariant: Schema.String,
}) {}

/**
 * A session's events were not caught up in time: its stream closed, or the
 * marker of a `synchronize` did not arrive within `SYNC_DEADLINE`. Only that
 * session is skipped, and tried again; it says nothing about the engine.
 */
export class NotObserved extends Schema.TaggedError<NotObserved>()("NotObserved", {}) {}

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
 * adds (room and teammate wakes) add their own variants here.
 */
export const WakePayload = Schema.Union([
  /** An operator message, read from its entry. */
  Schema.TaggedStruct("message", { entryId: EntryId }),
  /** The operator's answer to an `ask` card, read from the card. */
  Schema.TaggedStruct("answer", { cardId: EntryId }),
  /** The `user` dispatch this one follows up, whose turn delivered nothing. */
  Schema.TaggedStruct("undelivered", { dispatchId: DispatchRowId }),
  /** A run of a routine; for a webhook, the run holds the request's body. */
  Schema.TaggedStruct("routine", { routineId: RoutineId, runId: RoutineRunId }),
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

/**
 * How long a recovery waits after its `n`th undecided answer, an answer or a
 * held queue's resume after its `n`th lost reply, and a Stop target's fresh
 * round after its `n`th refused one since the engine last acknowledged one:
 * doubling from 2 s to 10 min.
 */
export const recoveryBackoff = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 * 2 ** Math.max(0, n - 1)), Duration.minutes(10));

/**
 * How long the engine has, after it acknowledged the `n`th round of a Stop
 * target, to show that what the round targets ended before a fresh round
 * follows: doubling from 30 s to 10 min. The engine's stop answers once it
 * recorded the interrupt, which the provider then carries out, in seconds:
 * 30 s leaves that a wide margin, and the runner confirms the Stop as soon as
 * the events show it took. Past it, the round was lost on the engine's side
 * (an interrupt it could not plan, a run whose provider never started), and
 * the doubling keeps a target the engine can never end from costing more
 * than a round every 10 min.
 */
export const stopGrace = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(30 * 2 ** Math.max(0, n - 1)), Duration.minutes(10));

/** A recovery that got this many undecided answers fails as `unresolved`. */
export const MAX_INDETERMINATE_ANSWERS = 10;

/** A dispatch older than this fails as `unresolved` instead of being recovered. */
export const RECOVERY_WINDOW = Duration.days(1);

/** How many times staging a dispatch's files may fail before it fails as `rejected`. */
export const MAX_STAGING_FAILURES = 5;

/**
 * How long a loop that found the engine unreachable waits for a readiness
 * change before it looks again anyway: the engine's status can trail it.
 */
export const UNAVAILABLE_RETRY = Duration.seconds(30);

/**
 * The longest a `synchronize` waits for its marker before it fails retryably.
 * Shorter than the adapter's own wait for a marker, so the server gives up
 * first and retries the session on its next pass (`docs/architecture/engine.md`).
 */
export const SYNC_DEADLINE = Duration.seconds(10);

/**
 * How long nothing is planned into a session after its `n`th first send in a
 * row was refused as busy, unless an event of it is applied first: doubling
 * from 2 s to 30 s. The adapter saw a turn whose start the server has not
 * applied yet, which is usually moments away.
 */
export const busyBackoff = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 * 2 ** Math.max(0, n - 1)), Duration.seconds(30));

/** The longest a bot tool request spends being matched to its call. */
export const ADMISSION_DEADLINE = Duration.seconds(15);

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
