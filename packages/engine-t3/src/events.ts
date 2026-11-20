// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalEntry,
  FailureClass,
  Question,
  SecretRequestEntry,
  WorkStep,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { EventCursor, HostSpeechId, IdempotencyKey, RequestId, SyncToken, TurnId } from "./ids.ts";

/** Why a turn started. */
export const TurnCause = Schema.Union([
  /**
   * The dispatch with this key is delivered by this turn. That is the turn a
   * `started`, `queued` or `new-turn` disposition named, or, for a `steered`
   * dispatch whose steer the agent never read, the follow-up turn the engine
   * made of it when the steered turn ended (any way but Stop). In that case the
   * dispatch moves to this turn; `lookupDispatch` still answers `steered`.
   */
  Schema.TaggedStruct("dispatch", { key: IdempotencyKey }),
  /**
   * The engine resumed a turn on its own after a usage limit reset or an engine
   * restart. Attribute it to whatever started `turnId`, and keep that turn's
   * audience.
   */
  Schema.TaggedStruct("continuation", { turnId: TurnId }),
  /**
   * The engine or the harness woke the session itself: background work the bot
   * started (a delegated task, a background command) finished or reported. Such
   * a turn answers no dispatch.
   */
  Schema.TaggedStruct("background", {}),
]);
export type TurnCause = typeof TurnCause.Type;

/** Something the engine is holding a turn on until the operator answers. */
export const EngineRequest = Schema.Union([
  Schema.TaggedStruct("approval", {
    kind: ApprovalEntry.fields.kind,
    action: ApprovalEntry.fields.action,
    detail: ApprovalEntry.fields.detail,
    allowsSession: ApprovalEntry.fields.allowsSession,
  }),
  /** The harness's own question tool, not the bot's `ask`. */
  Schema.TaggedStruct("question", { questions: Schema.NonEmptyArray(Question) }),
  /** A credential only the operator can give. Answered with `Engine.respondSecret`. */
  Schema.TaggedStruct("secret", {
    label: SecretRequestEntry.fields.label,
    reason: SecretRequestEntry.fields.reason,
    url: SecretRequestEntry.fields.url,
    placeholder: SecretRequestEntry.fields.placeholder,
  }),
]);
export type EngineRequest = typeof EngineRequest.Type;

export const OpenRequest = Schema.Struct({
  requestId: RequestId,
  turnId: TurnId,
  openedAt: Schema.DateTimeUtc,
  request: EngineRequest,
});
export type OpenRequest = typeof OpenRequest.Type;

/**
 * How a request closed. Never carries a secret value.
 * - `answered`: an approval or a question was answered or dismissed.
 * - `provided`, `declined`: a secret request was answered that way. A
 *   `respondSecret` retried after `EngineIndeterminate` that fails with
 *   `RequestClosed` took effect if, and only if, the request closed with the
 *   resolution it asked for.
 * - `expired`: the turn ended, or the provider withdrew the request, before an
 *   answer.
 */
export const RequestResolution = Schema.Literals(["answered", "provided", "declined", "expired"]);
export type RequestResolution = typeof RequestResolution.Type;

export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  /** By `stop`, by the provider, or by an engine restart. */
  Schema.TaggedStruct("interrupted", {}),
  /**
   * Ended before it started: a waiting turn that `stop` cancelled. A dispatch
   * delivered by it was dropped.
   */
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("failed", {
    failure: FailureClass,
    /** For a usage limit: when the provider said it resets. */
    retryAt: Schema.NullOr(Schema.DateTimeUtc),
  }),
]);
export type TurnOutcome = typeof TurnOutcome.Type;

/** A turn that has not ended. */
export const OpenTurn = Schema.Struct({
  turnId: TurnId,
  cause: TurnCause,
  /** Null while it waits behind another turn of the session. */
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Every step so far, in the order they started. */
  steps: Schema.Array(WorkStep),
});
export type OpenTurn = typeof OpenTurn.Type;

export const EndedTurn = Schema.Struct({
  turnId: TurnId,
  cause: TurnCause,
  outcome: TurnOutcome,
  /** As on `turn-finished`. */
  backgroundWork: Schema.Boolean,
  /** Every step, in its final state. */
  steps: Schema.Array(WorkStep),
});
export type EndedTurn = typeof EndedTurn.Type;

/** A use of the host's own speech tool, as `host-speech` carries it. */
export const HostSpeech = Schema.Struct({
  speechId: HostSpeechId,
  turnId: TurnId,
  text: Schema.String,
  at: Schema.DateTimeUtc,
});
export type HostSpeech = typeof HostSpeech.Type;

/** How a `steered` dispatch's steer settled within its turn. */
export const SteerSettlement = Schema.Struct({
  key: IdempotencyKey,
  turnId: TurnId,
  /** `read`: as the `steered` event; `dropped`: as `steer-dropped`. */
  settlement: Schema.Literals(["read", "dropped"]),
});
export type SteerSettlement = typeof SteerSettlement.Type;

const at = { cursor: EventCursor, at: Schema.DateTimeUtc };

/**
 * What happens in one session, in J3 Bots terms. Every event carries the cursor
 * to store once it has been applied. Applying an event twice must be harmless:
 * a `replaced` can repeat what the subscriber already applied.
 */
export const SessionEvent = Schema.Union([
  /**
   * The state of the session, sent instead of the events the subscriber missed
   * when they cannot be replayed (and first, when subscribing with no cursor).
   * Never sent next to a replay: a resume is either the events after the cursor
   * or one `replaced`.
   *
   * It is complete for reconciliation, which goes by stable ids. Apply it, and
   * store its cursor, in one transaction:
   * - `openTurns` is every turn that has not ended, with all its steps;
   *   anything the server holds as open that is not here has ended or never
   *   existed;
   * - `openRequests` is every request still waiting on the operator; a card the
   *   server holds open for any other request has closed;
   * - `endedTurns` is at least every turn that ended after the cursor, with its
   *   outcome and final steps. It may also hold turns the subscriber already saw
   *   end, because the engine keeps no sequence for a turn's end: applying one
   *   of those must change nothing. Empty when subscribing with no cursor;
   * - `hostSpeech` is at least every use of the host's speech tool after the
   *   cursor, in order, and may repeat ones already applied (by `speechId`);
   * - `closedRequests` is at least every request that closed after the cursor,
   *   with its resolution, and may repeat ones already applied;
   * - `steers` is how every steer settled on the turns listed, read or dropped.
   *   A steer still unread on an open turn is not listed; one that became a
   *   follow-up turn shows as that turn, with the dispatch as its cause.
   */
  Schema.TaggedStruct("replaced", {
    ...at,
    openTurns: Schema.Array(OpenTurn),
    openRequests: Schema.Array(OpenRequest),
    endedTurns: Schema.Array(EndedTurn),
    hostSpeech: Schema.Array(HostSpeech),
    closedRequests: Schema.Array(
      Schema.Struct({ requestId: RequestId, turnId: TurnId, resolution: RequestResolution }),
    ),
    steers: Schema.Array(SteerSettlement),
  }),
  /**
   * A turn began. Until its first step, the bot is thinking. A turn caused by a
   * dispatch is the moment that dispatch is delivered: the server admits it
   * here, not when `dispatch` returned.
   */
  Schema.TaggedStruct("turn-started", { ...at, turnId: TurnId, cause: TurnCause }),
  /**
   * The agent read a `steered` dispatch's message in the running turn: from now
   * on the dispatch's outcome is that turn's.
   */
  Schema.TaggedStruct("steered", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * `stop` reached the turn before the agent read a `steered` dispatch's
   * message. It was not delivered and will not be; the engine shows the
   * operator a notice of its own in its turn.
   */
  Schema.TaggedStruct("steer-dropped", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * A step was added or changed. Steps replace by id; the latest running step is
   * what the bot is doing right now.
   */
  Schema.TaggedStruct("step", { ...at, turnId: TurnId, step: WorkStep }),
  /**
   * The bot used the host's own tool for showing text to the user mid-turn
   * (`send_to_user` on Claude Code) instead of `say`. The server delivers the
   * text as speech, once per `speechId`, so a slip is not lost.
   */
  Schema.TaggedStruct("host-speech", {
    ...at,
    speechId: HostSpeechId,
    turnId: TurnId,
    text: Schema.String,
  }),
  /** The turn is held on the operator. */
  Schema.TaggedStruct("request-opened", { ...at, open: OpenRequest }),
  Schema.TaggedStruct("request-closed", {
    ...at,
    requestId: RequestId,
    turnId: TurnId,
    resolution: RequestResolution,
  }),
  Schema.TaggedStruct("turn-finished", {
    ...at,
    turnId: TurnId,
    outcome: TurnOutcome,
    /**
     * Background work the bot started in this turn (delegated tasks, background
     * commands) is still running and may wake the session later with a
     * `background` turn.
     */
    backgroundWork: Schema.Boolean,
  }),
  /**
   * Answers `Engine.synchronize` with this token: every event the engine had
   * recorded for the session when it was called has been delivered on this
   * stream, before this one. It changes no state; its cursor is that of the
   * last event delivered, so storing it is harmless.
   */
  Schema.TaggedStruct("synchronized", { ...at, token: SyncToken }),
]);
export type SessionEvent = typeof SessionEvent.Type;
