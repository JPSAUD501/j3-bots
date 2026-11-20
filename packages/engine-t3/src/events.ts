import { ApprovalEntry, FailureClass, Question, WorkStep } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { EventCursor, IdempotencyKey, RequestId, StepId, TurnId } from "./ids.ts";

/** Why a turn started. */
export const TurnCause = Schema.Union([
  /** A `dispatch` with this key started it. */
  Schema.TaggedStruct("dispatch", { key: IdempotencyKey }),
  /**
   * The engine resumed a turn on its own after a usage limit reset or an engine
   * restart. Attribute it to whatever started `turnId`.
   */
  Schema.TaggedStruct("continuation", { turnId: TurnId }),
  /** The engine woke the session because background work the bot started has finished. */
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
  Schema.TaggedStruct("question", { questions: Schema.NonEmptyArray(Question) }),
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
  /** By `interrupt` or `stop`, or by the provider. */
  Schema.TaggedStruct("interrupted", {}),
  Schema.TaggedStruct("failed", {
    failure: FailureClass,
    /** For a usage limit: when the provider said it resets. */
    retryAt: Schema.NullOr(Schema.DateTimeUtc),
  }),
]);
export type TurnOutcome = typeof TurnOutcome.Type;

export const ActiveTurn = Schema.Struct({
  turnId: TurnId,
  cause: TurnCause,
  startedAt: Schema.DateTimeUtc,
});
export type ActiveTurn = typeof ActiveTurn.Type;

const at = { cursor: EventCursor, at: Schema.DateTimeUtc };

/**
 * What happens in one session, in J3 Bots terms. Every event carries the cursor
 * to store once it has been applied.
 */
export const SessionEvent = Schema.Union([
  /**
   * The whole state of the session. Always the first event of a subscription,
   * and sent again whenever the adapter could not replay from a cursor (the
   * engine pruned its history). It replaces everything derived from earlier
   * events: a turn the server believed running and that is not `activeTurn` has
   * ended, and `Engine.lookupDispatch` tells how.
   */
  Schema.TaggedStruct("snapshot", {
    ...at,
    activeTurn: Schema.NullOr(ActiveTurn),
    openRequests: Schema.Array(OpenRequest),
    /** Dispatches waiting behind the active turn, in the order they will start. */
    queued: Schema.Array(IdempotencyKey),
  }),
  /** A turn began. Until its first step, the bot is thinking. */
  Schema.TaggedStruct("turn-started", { ...at, turnId: TurnId, cause: TurnCause }),
  /** A `steer` dispatch reached the running turn. */
  Schema.TaggedStruct("steered", { ...at, key: IdempotencyKey, turnId: TurnId }),
  /**
   * A step was added or changed. Steps replace by `stepId`; the latest running
   * step is what the bot is doing right now.
   */
  Schema.TaggedStruct("step", { ...at, turnId: TurnId, stepId: StepId, step: WorkStep }),
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
     * Background work the bot started in this turn (delegated tasks, monitors)
     * is still running and may wake the session later with a `background` turn.
     */
    backgroundWork: Schema.Boolean,
  }),
  /**
   * Queued dispatches that will not run: `stop` cancelled them, or the engine
   * dropped them. They will never produce a turn.
   */
  Schema.TaggedStruct("dispatches-cancelled", { ...at, keys: Schema.Array(IdempotencyKey) }),
]);
export type SessionEvent = typeof SessionEvent.Type;
