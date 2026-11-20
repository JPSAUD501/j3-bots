// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalEntry,
  FailureClass,
  Question,
  SecretRequestEntry,
  WorkStep,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import {
  EventCursor,
  HostSpeechId,
  IdempotencyKey,
  RequestId,
  SyncToken,
  ToolCallId,
  ToolInputDigest,
  TurnId,
} from "./ids.ts";

/** Why a turn started. */
export const TurnCause = Schema.Union([
  /**
   * The dispatch with this key is delivered by this turn. That is the turn a
   * `started`, `queued` or `new-turn` disposition named, or, for a `steered`
   * dispatch, the follow-up turn a `steer-requeued` named. A turn takes its
   * cause from its first attempt: a turn the engine restarted to take a steer
   * keeps it.
   */
  Schema.TaggedStruct("dispatch", { key: IdempotencyKey }),
  /**
   * The engine resumed, on its own, the turn `turnId`, which ended with a
   * pending `continuation` (a usage limit that has now reset). `turnId` is the
   * turn this one directly continues, which may itself be a continuation: the
   * server follows the chain one link at a time, moving whatever `turnId`
   * answered (its dispatch, its audience) to this turn.
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
 * - `provided`, `declined`: a secret request was answered that way, by
 *   whichever answer reached the engine first. It says nothing about which
 *   submission that was: see `Engine.respondSecret`.
 * - `expired`: the turn ended, or the provider withdrew the request, before an
 *   answer.
 */
export const RequestResolution = Schema.Literals(["answered", "provided", "declined", "expired"]);
export type RequestResolution = typeof RequestResolution.Type;

export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  /**
   * By `stop`, by the provider, or by an engine restart. The adapter sets the
   * engine up not to continue turns after its own restart, so such a turn stays
   * ended.
   */
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

/**
 * A call the bot made to one of the `j3` tools, as the engine recorded it in
 * the turn. Calls to other tools are steps.
 */
export const ToolCall = Schema.Struct({
  callId: ToolCallId,
  /** The bare tool name (`say`), whatever name the harness gives it. */
  tool: Schema.String,
  /** `toolInputDigest` of the input the engine recorded. */
  inputDigest: ToolInputDigest,
});
export type ToolCall = typeof ToolCall.Type;

/**
 * The engine will resume an ended turn on its own: it failed at a usage limit
 * and the engine arms a resume for the reset (**Read** at `db51b67`,
 * `UsageLimitRecoveryWorker.ts`). The resumed turn is a `continuation` of it.
 */
export const PendingContinuation = Schema.Struct({ resumesAt: Schema.DateTimeUtc });
export type PendingContinuation = typeof PendingContinuation.Type;

/** A turn that has not ended. */
export const OpenTurn = Schema.Struct({
  turnId: TurnId,
  cause: TurnCause,
  /**
   * When its provider turn started: the moment it was admitted. Null while it
   * waits behind another turn of the session, or for the engine to start it.
   */
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Every step so far, in the order they started. */
  steps: Schema.Array(WorkStep),
  /** Its `j3` tool calls still in progress. */
  toolCalls: Schema.Array(ToolCall),
});
export type OpenTurn = typeof OpenTurn.Type;

export const EndedTurn = Schema.Struct({
  turnId: TurnId,
  cause: TurnCause,
  /**
   * When its provider turn started. Null when it ended without starting: it was
   * cancelled while waiting, or failed before the provider took it. A turn
   * caused by a dispatch delivered that dispatch if, and only if, this is set.
   */
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.DateTimeUtc,
  outcome: TurnOutcome,
  /** As on `turn-finished`. */
  backgroundWork: Schema.Boolean,
  /** As on `turn-finished`, as it stands now: null once it ran or was dropped. */
  continuation: Schema.NullOr(PendingContinuation),
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

/**
 * How a `steered` dispatch's steer settled when the turn it steered ended.
 * `read`: as the `steered` event; `dropped`: as `steer-dropped`. A steer that
 * was requeued shows as its follow-up turn instead, with the dispatch as cause.
 */
export const SteerSettlement = Schema.Struct({
  key: IdempotencyKey,
  turnId: TurnId,
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
   * - `openTurns` is every turn that has not ended, with all its steps and
   *   its `j3` tool calls in progress; anything the server holds as open that
   *   is not here has ended or never existed;
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
   * - `steers` is how every steer settled on the ended turns listed, read or
   *   dropped. A steer of an open turn is not listed: it settles when that turn
   *   ends. One that was requeued shows as its follow-up turn, with the
   *   dispatch as its cause.
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
   * How a `steered` dispatch settled is known only once the turn it steered has
   * ended, so each of these three follows that turn's `turn-finished`, one per
   * steer, and nothing about the steer comes before. Until then the dispatch
   * is undecided.
   *
   * `steered`: the steered turn took the message: the dispatch was delivered,
   * and its outcome is that turn's.
   */
  Schema.TaggedStruct("steered", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * `stop` ended the steered turn before the agent took the message. It was not
   * delivered and will not be; the engine shows the operator a notice of its
   * own in that turn.
   */
  Schema.TaggedStruct("steer-dropped", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * The steered turn ended without taking the message, any way but Stop, and
   * the engine queued it as turn `followUpTurnId`, whose cause is this
   * dispatch. The dispatch moves to that turn and is delivered when it starts.
   */
  Schema.TaggedStruct("steer-requeued", {
    ...at,
    key: IdempotencyKey,
    turnId: TurnId,
    followUpTurnId: TurnId,
  }),
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
  /**
   * The bot called a `j3` tool (`open`), or the call returned (`closed`). The
   * engine records a call apart from the request the `j3` bridge receives for
   * it, so this can arrive after that request. A turn's end closes every call
   * of the turn still open, without a `closed` for each.
   */
  Schema.TaggedStruct("tool-call", {
    ...at,
    turnId: TurnId,
    call: ToolCall,
    state: Schema.Literals(["open", "closed"]),
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
    /**
     * The engine will resume this turn on its own as a `continuation` turn.
     * Until that turn starts, or `continuation-dropped` arrives, the turn's
     * work is not over: a dispatch it delivered stays open.
     */
    continuation: Schema.NullOr(PendingContinuation),
  }),
  /**
   * The pending continuation of the ended turn `turnId` will not run: the
   * engine cleared it, or a newer message took its place.
   */
  Schema.TaggedStruct("continuation-dropped", { ...at, turnId: TurnId }),
  /**
   * Answers `Engine.synchronize` with this token: every event the engine had
   * recorded for the session when it was called has been delivered on this
   * stream, before this one. It changes no state; its cursor is that of the
   * last event delivered, so storing it is harmless.
   */
  Schema.TaggedStruct("synchronized", { ...at, token: SyncToken }),
]);
export type SessionEvent = typeof SessionEvent.Type;
