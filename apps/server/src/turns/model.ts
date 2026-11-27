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
  SecretName,
} from "@j3-bots/contracts";
import { TurnId } from "@j3-bots/engine-t3";
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

/** The turn a bot's `create_bot` made a bot in: its session row and the engine's turn. */
export const MadeIn = Schema.Struct({ sessionId: SessionRowId, turnId: TurnId });
export type MadeIn = typeof MadeIn.Type;

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

/**
 * Lower is first: the operator, then rooms, teammates, J3 Bots itself and
 * routines. The operator's own room message is a `room` wake that goes at
 * `user` priority (`priorityOf`).
 */
export const PRIORITY: { readonly [K in WakeKind]: number } = {
  user: 0,
  room: 1,
  bot: 2,
  system: 3,
  routine: 4,
};

/**
 * A wake's priority: its kind's, except that a room wake the operator caused
 * goes first like any of the operator's, and may steer a running turn of the
 * same room (`docs/architecture/server.md`, The server holds waiting wakes).
 */
export const priorityOf = (kind: WakeKind, byOperator: boolean): number =>
  kind === "room" && byOperator ? PRIORITY.user : PRIORITY[kind];

/**
 * Why a bot is woken for a room (`docs/architecture/server.md`, Rooms): it is
 * the kickoff of a room a bot started, the message mentions the member
 * (`addressed`) or everyone, or, mentioning nobody, the operator wrote it
 * (`user`) or another member did (`member`).
 */
export const RoomReason = Schema.Literals(["kickoff", "addressed", "everyone", "user", "member"]);
export type RoomReason = typeof RoomReason.Type;

/** What a wake carries, read when its envelope is rendered. */
export const WakePayload = Schema.Union([
  /** An operator message, read from its entry. */
  Schema.TaggedStruct("message", { entryId: EntryId }),
  /** The operator's answer to an `ask` card, read from the card. */
  Schema.TaggedStruct("answer", { cardId: EntryId }),
  /**
   * How the operator's help in the bot's browser ended: the card's answer or
   * expiry, read from the card (`cardId`), or, with no card, the operator
   * giving back a browser they took while the bot worked.
   */
  Schema.TaggedStruct("browser-help", {
    cardId: Schema.NullOr(EntryId),
    outcome: Schema.Literals(["done", "declined", "tab-closed", "timed-out", "handed-back"]),
    /** The host name of the page the card was about; null with no card, or a page with none. */
    site: Schema.NullOr(Schema.String),
  }),
  /**
   * How the bot's ask for a secret ended: saved from its card, declined, or
   * expired. `name` is the secret's, which the bot names it by.
   */
  Schema.TaggedStruct("secret-ask", {
    cardId: EntryId,
    outcome: Schema.Literals(["saved", "declined", "expired"]),
    name: SecretName,
  }),
  /**
   * How the bot's ask to add a connector its operator had to allow ended
   * (`ConnectorAsks`): added on their yes, declined, failed after their yes,
   * or expired. `server` is the connector's name; `note` says what comes next
   * for one added, or why one failed.
   */
  Schema.TaggedStruct("connector-ask", {
    cardId: EntryId,
    outcome: Schema.Literals(["added", "declined", "failed", "expired"]),
    server: Schema.String,
    note: Schema.NullOr(Schema.String),
  }),
  /** The `user` dispatch this one follows up, whose turn delivered nothing. */
  Schema.TaggedStruct("undelivered", { dispatchId: DispatchRowId }),
  /**
   * A delegated task's result the engine put into a turn of another
   * audience, brought to the audience of the turn that delegated it
   * (`origin`, in the same session): the turn it wakes goes on with that
   * turn's work (`docs/architecture/server.md`, Sessions). `text` is what the
   * engine told of the result.
   */
  Schema.TaggedStruct("delegated-result", { origin: TurnId, text: Schema.String }),
  /**
   * The bot was just created: its first turn opens its conversation. A bot
   * another bot's `create_bot` made waits for the turn that made it
   * (`madeIn`) to end, which may place it in a room instead (`start_room`).
   * `fromTemplate`: it was made from a template, whose author, not the
   * operator, wrote its job, skills and routines.
   */
  Schema.TaggedStruct("first-run", {
    madeIn: Schema.optionalKey(MadeIn),
    fromTemplate: Schema.optionalKey(Schema.Literal(true)),
  }),
  /** A run of a routine; for a webhook, the run holds the request's body. */
  Schema.TaggedStruct("routine", { routineId: RoutineId, runId: RoutineRunId }),
  /** A teammate's urgent message, read from the handoff card it put in this bot's conversation. */
  Schema.TaggedStruct("teammate", { entryId: EntryId }),
  /**
   * A room message that addresses this bot; the envelope carries every entry
   * of the room the bot has not seen, this one among them.
   */
  Schema.TaggedStruct("room", { entryId: EntryId, reason: RoomReason }),
  /**
   * The operator reacted to this bot's message (`entryId`): a `system` wake
   * for the message's audience, whose quiet turn reads the reactions on it as
   * they stand when it is dispatched (`reactions/Reactions.ts`).
   */
  Schema.TaggedStruct("reaction", { entryId: EntryId }),
]);
export type WakePayload = typeof WakePayload.Type;

/**
 * What a bot's main session has not seen, reported at the top of its next
 * envelope there: a digest of the recent conversation when the session was
 * replaced, and, from M2, routine runs in side sessions and profile edits.
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
  /**
   * Reactions on a message of the bot's conversation or of a room it is in
   * changed: its next envelope tells them as they stand then, or nothing once
   * none is left but its own. One per bot and message while it waits.
   */
  Schema.TaggedStruct("reactions", { entryId: EntryId }),
  /** The bot's main session was replaced; `digest` is what the new one is told of the conversation. */
  Schema.TaggedStruct("session-rotated", {
    digest: Schema.Array(
      Schema.Struct({
        from: Schema.Literals(["user", "you"]),
        text: Schema.String,
        files: Schema.Array(Schema.String),
        // The window the operator wrote it over; absent from a note kept before it was told.
        lookingAt: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ app: Schema.String, title: Schema.NullOr(Schema.String) })),
        ),
      }),
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

/**
 * The longest a room's Stop round waits on work of another audience that the
 * server cannot see run: a dispatch the engine took whose turn no event shows,
 * or a run the engine's report lists that no event told of. Such a run starts
 * in seconds, and then holds the round for as long as it visibly runs; one
 * stuck in startup would otherwise hold the room's Stop for good. Counted from
 * when the round was first held by such work alone, durably (`Stops`).
 */
export const ROOM_ROUND_HOLD_BOUND = Duration.minutes(2);

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
]);
export type StoredResponse = typeof StoredResponse.Type;
