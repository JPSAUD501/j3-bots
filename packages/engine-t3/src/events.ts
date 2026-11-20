// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ApprovalEntry,
  FailureClass,
  Question,
  SecretRequestEntry,
  WorkStep,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { EventCursor, IdempotencyKey, RequestId, TurnId } from "./ids.ts";

/** Why a turn started. */
export const TurnCause = Schema.Union([
  /**
   * A `dispatch` with this key started it, either as a `start` or as a `steer`
   * the engine turned into a turn of its own (disposition `new-turn`).
   */
  Schema.TaggedStruct("dispatch", { key: IdempotencyKey }),
  /**
   * The engine resumed a turn on its own after a usage limit reset or an engine
   * restart. Attribute it to whatever started `turnId`.
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

export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  /** By `interrupt` or `stop`, by the provider, or by an engine restart. */
  Schema.TaggedStruct("interrupted", {}),
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
});
export type EndedTurn = typeof EndedTurn.Type;

const at = { cursor: EventCursor, at: Schema.DateTimeUtc };

/**
 * What happens in one session, in J3 Bots terms. Every event carries the cursor
 * to store once it has been applied.
 */
export const SessionEvent = Schema.Union([
  /**
   * The whole state of the session, sent instead of the events the subscriber
   * missed when they cannot be replayed (and first, when subscribing with no
   * cursor). Never sent next to a replay: a resume is either the events after
   * the cursor or one `replaced`.
   *
   * It replaces everything derived from earlier events. Apply it, and store its
   * cursor, in one transaction:
   * - `openTurns` is every turn that has not ended, with all its steps;
   * - `openRequests` is every request still waiting on the operator; a card the
   *   server holds open for any other request has closed;
   * - `endedTurns` is every turn that ended after the subscriber's cursor, with
   *   its outcome. Empty when subscribing with no cursor.
   */
  Schema.TaggedStruct("replaced", {
    ...at,
    openTurns: Schema.Array(OpenTurn),
    openRequests: Schema.Array(OpenRequest),
    endedTurns: Schema.Array(EndedTurn),
  }),
  /** A turn began. Until its first step, the bot is thinking. */
  Schema.TaggedStruct("turn-started", { ...at, turnId: TurnId, cause: TurnCause }),
  /** A `steer` dispatch reached the running turn. */
  Schema.TaggedStruct("steered", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * A step was added or changed. Steps replace by id; the latest running step is
   * what the bot is doing right now.
   */
  Schema.TaggedStruct("step", { ...at, turnId: TurnId, step: WorkStep }),
  /**
   * The bot used the host's own tool for showing text to the user mid-turn
   * (`send_to_user` on Claude Code) instead of `say`. The server delivers the
   * text as speech, so a slip is not lost.
   */
  Schema.TaggedStruct("host-speech", { ...at, turnId: TurnId, text: Schema.String }),
  /** The turn is held on the operator. */
  Schema.TaggedStruct("request-opened", { ...at, open: OpenRequest }),
  Schema.TaggedStruct("request-closed", {
    ...at,
    requestId: RequestId,
    /** `expired`: the turn ended or the provider withdrew it before an answer. */
    resolution: Schema.Literals(["answered", "expired"]),
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
]);
export type SessionEvent = typeof SessionEvent.Type;
