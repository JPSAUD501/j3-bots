// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { IdempotencyKey, RequestId, SessionId, TurnId } from "./ids.ts";

/**
 * The engine cannot take commands right now: it is starting, restarting, or its
 * socket is reconnecting. The command was not sent, so nothing was applied.
 * Retry the same command, with the same key, once `Engine.status` reports
 * `ready`.
 */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()(
  "EngineUnavailable",
  {},
) {
  override get message(): string {
    return "The engine is not reachable.";
  }
}

/**
 * The command was sent, but no definite answer came back: the connection
 * dropped, the engine restarted before it answered, or it answered with an
 * error the adapter cannot identify. It may or may not have been applied, and
 * this error never means it was not.
 *
 * The engine's `/ws` reply to a failed command is one generic error whose cause
 * keeps only the class name and message of what went wrong, and a refusal it
 * records (a rejected receipt) answers its first submission with the same kind
 * of error as a failure after the command was applied. So only a resend can
 * tell them apart. A dispatch is resolved with `Engine.redispatch` under the
 * same key. Every other keyed command is resolved by sending it again with the
 * same key and input. A command without a key is idempotent by nature, except
 * `respondSecret`: see there. **Read** at `db51b67`: `apps/server/src/ws.ts`
 * (`OrchestrationV2DispatchCommandError`, `cause: Schema.Defect()`), Effect's
 * `Schema.Defect` encoding `{name, message, cause?}`.
 */
export class EngineIndeterminate extends Schema.TaggedError<EngineIndeterminate>()(
  "EngineIndeterminate",
  {},
) {
  override get message(): string {
    return "The engine did not answer; the command may have been applied.";
  }
}

/** The running engine is not the pinned version. No command is sent to it. */
export class EngineIncompatible extends Schema.TaggedError<EngineIncompatible>()(
  "EngineIncompatible",
  { runningVersion: Schema.String, pinnedVersion: Schema.String },
) {
  override get message(): string {
    return `The engine runs version ${this.runningVersion}, but J3 Bots is pinned to ${this.pinnedVersion}.`;
  }
}

/**
 * The session does not exist, or it was retired. Only the engine's word that
 * it has no record of the session's thread makes it missing: a read the
 * engine failed is `EngineUnavailable`, never a loss. From `dispatch`, the
 * adapter found this before sending anything: the key was never sent, and
 * the caller may use the wakes again. `redispatch` never fails this way,
 * since it skips every local check.
 */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId,
}) {
  override get message(): string {
    return `The engine has no session ${this.sessionId}.`;
  }
}

/**
 * A first `start` was refused before it was sent, because the adapter saw a
 * turn running or waiting to start in the session: usually one the engine
 * started itself. Nothing was sent, so the caller may use the wakes again once
 * the session is idle. `redispatch` never fails this way.
 *
 * Best effort only: a turn can begin between this check and the engine
 * applying the start, and then the dispatch is accepted as `queued` instead.
 */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  sessionId: SessionId,
  turnId: TurnId,
}) {
  override get message(): string {
    return `The session ${this.sessionId} is busy with turn ${this.turnId}.`;
  }
}

/**
 * A change of a session's model or permission mode was refused, because the
 * provider session it would replace still runs background work (a delegated
 * agent, a command left running) that the change would end. That change was
 * not applied. It is taken once the background work ends, or after a Stop
 * ended it. **Read** at `db51b67`, `Orchestrator.ts` (L4744-4757): a Claude
 * Code session cannot change its permission mode in place, so the change
 * replaces its provider session, and the engine refuses that while the
 * session has background work.
 */
export class BackgroundWorkRunning extends Schema.TaggedError<BackgroundWorkRunning>()(
  "BackgroundWorkRunning",
  { sessionId: SessionId },
) {
  override get message(): string {
    return `The session ${this.sessionId} runs background work that changing its settings would end.`;
  }
}

/**
 * The engine refused a dispatch, and nothing of it was applied. The adapter
 * reports it only on positive evidence it can read on `/ws`, by the class name
 * the error's cause keeps:
 * - `OrchestratorCommandPreviouslyRejectedError`: a resend found the key's
 *   rejected receipt. The engine writes one for every refusal it makes while
 *   planning a command, whatever the reason: a steer into a turn that Stop
 *   already reached, that waits behind another turn or that ended any way
 *   but completing (`dispatchSteerIntoRun`), a thread that is not active, a
 *   provider that cannot take it.
 * - `OrchestratorRuntimeModeAboveCeilingError`: the managed policy's
 *   runtime-mode ceiling refused it. It is checked after the receipt lookup,
 *   under the thread's lock, and leaves no receipt, so the key was not applied
 *   before either.
 *
 * Every other error is `EngineIndeterminate`. Two refusals come before the
 * receipt lookup and so say nothing about an earlier submission:
 * `AttachmentClaimError` (a staged file the engine cannot claim), which is a
 * defect of the caller, since a dispatch names only files staged and still
 * usable; and `ThreadManagementProviderInstanceDisabledError`, which is
 * indeterminate. `OrchestratorThreadAboveModeLimitError` (the dispatch mode
 * limit) binds only agent and MCP callers, never `/ws`.
 * **Read** at `db51b67`: `Orchestrator.ts` (`dispatchWithReceiptEffect`,
 * `replayCommandReceipt`), `ThreadMessageIntake.ts` (`dispatchCommand`),
 * `ThreadManagementService.ts` (`assertDispatchTargetEnabled`),
 * `DispatchModeLimit.ts`.
 *
 * The caller never sends the key again.
 */
export class DispatchRejected extends Schema.TaggedError<DispatchRejected>()("DispatchRejected", {
  key: IdempotencyKey,
}) {
  override get message(): string {
    return `The engine refused the dispatch ${this.key}; nothing was applied.`;
  }
}

/**
 * The engine refused a round of a Stop, and something the Stop targets can
 * still run: a turn that has not ended and is not waiting in the queue,
 * background work the engine counts as pending, or a continuation it will
 * start on its own. The adapter reports it only once a resend of the key
 * found its rejected receipt (`OrchestratorCommandPreviouslyRejectedError`),
 * as for `DispatchRejected`; the engine keeps that receipt for good, so the
 * key is spent. A refusal while nothing targeted can run is moot and counts
 * as done. **Read** at `db51b67`, `Orchestrator.ts`: a refusal while planning
 * commits a rejected receipt (L16018-16034), and a resend replays it
 * (`replayCommandReceipt`, L15867-15877).
 *
 * The caller stops the session again with a fresh key.
 */
export class StopRejected extends Schema.TaggedError<StopRejected>()("StopRejected", {
  key: IdempotencyKey,
}) {
  override get message(): string {
    return `The engine refused the Stop ${this.key} while its work can still run.`;
  }
}

/**
 * The engine refused an answer, and its request is still open. The adapter
 * reports it only once a resend of the key found its rejected receipt
 * (`OrchestratorCommandPreviouslyRejectedError`), as for `DispatchRejected`.
 * The engine keeps that receipt for good, so the key is spent: sending it
 * again is refused again (**Verified** on `0.1.11` with a refused dismissal:
 * its resend was "previously rejected"). **Read** at `59651c1`,
 * `Orchestrator.ts` (`dispatchRuntimeRequestRespond`): the engine refuses an
 * answer to an open request it cannot deliver, one whose provider session is
 * gone or that it marked `not_resumable`; a question answered by a later
 * message is also refused while its provider is disabled, or when the answer
 * leaves one of its questions unanswered. It checks no other answer to a
 * question a turn waits on.
 *
 * The caller never sends the key again. The request stays open until the
 * turn ends or is stopped.
 */
export class AnswerRejected extends Schema.TaggedError<AnswerRejected>()("AnswerRejected", {
  key: IdempotencyKey,
  requestId: RequestId,
}) {
  override get message(): string {
    return `The engine refused the answer ${this.key} to the open request ${this.requestId}.`;
  }
}

/**
 * The engine refused to open a session under the key, and nothing was
 * opened. The adapter reports it only once a resend of the key found its
 * rejected receipt (`OrchestratorCommandPreviouslyRejectedError`), as for
 * `DispatchRejected`, so the key is spent: sent again, it is refused again
 * (**Verified** on `0.1.11`, in the conformance suite). The engine plans a new
 * thread by checking only that its id is free, which the key's own thread id
 * is unless another client took it, so what it refuses is otherwise a
 * projection read that failed while planning: a cause that passes. **Read**
 * at `59651c1`, `Orchestrator.ts` (`dispatchThreadCreate`, and
 * `dispatchWithReceiptEffect`, which commits a rejected receipt for every
 * error while planning).
 *
 * The caller never sends the key again: it opens the session later under a
 * fresh key, which names a thread of its own.
 */
export class OpenRejected extends Schema.TaggedError<OpenRejected>()("OpenRejected", {
  key: IdempotencyKey,
}) {
  override get message(): string {
    return `The engine refused to open a session under ${this.key}; nothing was opened.`;
  }
}

/**
 * The engine refused a retirement's Stop round or its archive, and the
 * session is neither archived nor gone. Nothing was archived. The engine
 * refuses an archive while the thread has delegated tasks running, and the
 * Stop before it only queues their end, so an archive sent at once can meet
 * them still running (**Read** at `59651c1`, `Orchestrator.ts`,
 * `dispatchThreadMutation` and `dispatchThreadStop`). Every retirement sends
 * keys of its own.
 *
 * The caller retires the session again later.
 */
export class RetireRejected extends Schema.TaggedError<RetireRejected>()("RetireRejected", {
  sessionId: SessionId,
}) {
  override get message(): string {
    return `The engine refused to retire the session ${this.sessionId} for now.`;
  }
}

/** The request was already answered, or expired with its turn. */
export class RequestClosed extends Schema.TaggedError<RequestClosed>()("RequestClosed", {
  requestId: RequestId,
}) {
  override get message(): string {
    return `The request ${this.requestId} is no longer open.`;
  }
}

/** The provider is not configured in the engine, or does not offer the model. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  providerId: ProviderId,
  modelId: ModelId,
}) {
  override get message(): string {
    return `The engine does not offer ${this.modelId} on ${this.providerId}.`;
  }
}

/**
 * Every engine command can fail this way. `EngineUnavailable` and
 * `EngineIncompatible` applied nothing; `EngineIndeterminate` may have.
 */
export const EngineDown = Schema.Union([
  EngineUnavailable,
  EngineIndeterminate,
  EngineIncompatible,
]);
export type EngineDown = typeof EngineDown.Type;
