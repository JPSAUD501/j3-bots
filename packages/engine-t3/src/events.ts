// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalEntry,
  FailureClass,
  MAX_CARD_QUESTIONS,
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
   * turn this one directly continues, which the engine names on the resuming
   * message (`usageLimitContinuationOfRunId`), and which may itself be a
   * continuation: the server follows the chain one link at a time, moving the
   * dispatch that owned `turnId` and its audience to this turn.
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
    reason: ApprovalEntry.fields.reason,
    exact: ApprovalEntry.fields.exact,
    sessionGrant: ApprovalEntry.fields.sessionGrant,
  }),
  /**
   * The harness's own question tool, not the bot's `ask`. Question and option
   * ids are J3 Bots' own, stable for the request; the adapter maps an answer
   * back to the engine's exact question keys and option values.
   */
  Schema.TaggedStruct("question", {
    questions: Schema.NonEmptyArray(Question).check(Schema.isMaxLength(MAX_CARD_QUESTIONS)),
  }),
  /**
   * A question from the harness's own tool that a card cannot show whole: more
   * questions than one card holds, or a question with more options than one
   * shows. Nothing of it is dropped silently: the server shows a notice saying
   * why, and the only answer is `dismiss`, which the bot reads as "no".
   * `count` is how many the engine asked for, `max` how many a card shows.
   */
  Schema.TaggedStruct("unsupported-question", {
    exceeds: Schema.Literals(["questions", "options"]),
    count: Schema.Int,
    max: Schema.Int,
  }),
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
 * and the engine arms a resume for the reset. The resumed turn is a
 * `continuation` of it.
 *
 * The engine arms the resume asynchronously, so the adapter predicts it from
 * the conditions the engine's worker checks, and then follows the engine's own
 * record of it, the armed recovery and its `autoResume`. The conditions: the
 * session's latest executed turn (queued turns and turns cancelled before they
 * started do not count) failed; its root failure, the latest failed error on
 * the turn's root node, is a usage limit whose reset lies after the turn's
 * end; the session is not archived or settled and waits on no request; and
 * the recovery is armed for that turn and reset, or not armed yet with the
 * reset less than a day past. A snooze only delays a continuation; it never
 * prevents one. **Read** at `db51b67`: `ProjectionStore.ts`
 * (`getLimitRecoveryCandidates`), `UsageLimitRecoveryWorker.ts`
 * (`limitRecoveryCommand`, `MAX_OVERDUE_ARM_MS`).
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
 * Either is the engine's claim: see `steered`.
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
   *   dispatch as its cause;
   * - `queueHeld` says the session's queue is held now. If it is, this event
   *   stands for the hold, as a `queue-held` would, and its cursor is the
   *   hold's.
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
    queueHeld: Schema.Boolean,
  }),
  /**
   * A turn began. Until its first step, the bot is thinking. A turn caused by a
   * dispatch is the moment that dispatch is delivered: the server admits it
   * here, not when `dispatch` returned.
   */
  Schema.TaggedStruct("turn-started", { ...at, turnId: TurnId, cause: TurnCause }),
  /**
   * The engine queued a start behind another turn: it has the turn, which has
   * not started. Sent once, before the turn's `turn-started` or
   * `turn-finished`, for a turn whose opening message the engine marked as
   * queued, as a `queued` disposition does. A dispatch it delivers is accepted
   * here, also when the reply that would have said so was lost.
   */
  Schema.TaggedStruct("turn-queued", { ...at, turnId: TurnId, cause: TurnCause }),
  /**
   * How a `steered` dispatch settled is known only once the turn it steered has
   * ended, so each of these three follows that turn's `turn-finished`, one per
   * steer, and nothing about the steer comes before. Until then the dispatch
   * is undecided. The adapter reads the settlement from the engine's own
   * record of the steer once the turn has settled: requeued, cancelled by
   * Stop, or neither.
   *
   * A steer sent before the target's provider turn started waits in the
   * engine as a run of its own that carries the message. When the target
   * starts, the engine cancels that carrier and steers the message in; the
   * adapter reports neither the carrier nor its cancellation. If the target
   * ends first, the carrier is the follow-up of `steer-requeued`.
   *
   * `steered`: the steered turn took the message: the dispatch was delivered,
   * and it finishes with that turn. This is the engine's claim, and two
   * provider paths make it without proof the model read the message: Codex
   * acknowledges a steer when it is sent, never when it is consumed, and
   * Claude Code marks a steer taken when offering it to the running turn
   * fails. **Read** at `db51b67`: `Orchestrator.ts` (`requeueUnreadSteers`,
   * `queued-message.promote-to-steer`), `CodexAdapterV2.ts` and
   * `ClaudeAdapterV2.ts` (`steerTurn`).
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
  /**
   * What an open request shows changed while it still waits on the operator:
   * the engine's record of it reached the adapter after it opened, such as a
   * file change's diff, which the adapter fetches apart. The server replaces
   * the card it shows; the request and an answer already on its way stay the
   * same. Never sent for a request that has closed.
   */
  Schema.TaggedStruct("request-updated", {
    ...at,
    requestId: RequestId,
    turnId: TurnId,
    request: EngineRequest,
  }),
  Schema.TaggedStruct("request-closed", {
    ...at,
    requestId: RequestId,
    turnId: TurnId,
    resolution: RequestResolution,
  }),
  Schema.TaggedStruct("turn-finished", {
    ...at,
    turnId: TurnId,
    /**
     * Why the turn started, as `turn-started` says it, and the same when the
     * turn never started: a waiting turn that `stop` cancelled, or one that
     * failed before its provider took it, has no `turn-started`. A turn caused
     * by a dispatch settles that dispatch by its key here, also when the
     * server learned of the dispatch only through `redispatch`, which has no
     * disposition.
     */
    cause: TurnCause,
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
   * The pending continuation of the ended turn `turnId` will not run: `stop`
   * disarmed it (the engine's armed recovery no longer resumes on its own), a
   * newer turn started in the session, or the session stopped qualifying for
   * it (archived, waiting on a request, or past the one-day limit). **Read**
   * at `db51b67`: `Orchestrator.ts` (`holdStoppedThread`),
   * `UsageLimitRecoveryWorker.ts`.
   */
  Schema.TaggedStruct("continuation-dropped", { ...at, turnId: TurnId }),
  /**
   * The engine held the session's queue of waiting turns: after an engine
   * restart, a provider error, a model or provider change while the replaced
   * provider session still runs background work, or a Stop. One per hold;
   * the server answers it with `Engine.resumeQueue`, naming this cursor. A
   * hold the engine puts back in answer to that resume, before any turn
   * started, is not reported until its cause has passed: then it comes as a
   * new `queue-held`. **Read** at `db51b67`: `Orchestrator.ts`
   * (`startNextQueuedRun`, `queue.resume`); the hold is a field of each
   * waiting run.
   */
  Schema.TaggedStruct("queue-held", { ...at }),
  /**
   * Answers `Engine.synchronize` with this token: every event the engine had
   * recorded for the session when it was called has been delivered on this
   * stream, before this one. It changes no state; its cursor is that of the
   * last event delivered, so storing it is harmless.
   */
  Schema.TaggedStruct("synchronized", {
    ...at,
    token: SyncToken,
    /**
     * The session has background work the engine counts as pending, with no
     * turn running: what `stop` interrupts in an idle session, and which ends
     * only after the stop answered.
     */
    backgroundWork: Schema.Boolean,
    /**
     * Turns the engine is starting at once, whose provider turn has not
     * started: no event has told of them yet, and each will show as
     * `turn-started`, or end without starting. A Stop sent before one was
     * created did not reach it.
     */
    startingTurns: Schema.Array(TurnId),
  }),
]);
export type SessionEvent = typeof SessionEvent.Type;
