import { ModelId, ProviderId } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { EngineProjectId, RequestId, SessionId, TurnId } from "./ids.ts";

/**
 * The engine cannot take commands right now: it is starting, restarting, or its
 * socket is reconnecting. Nothing was applied. Retry the same command, with the
 * same key, once `Engine.status` reports `ready`.
 */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()(
  "EngineUnavailable",
  {},
) {
  override get message(): string {
    return "The engine is not reachable.";
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

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  projectId: EngineProjectId,
}) {
  override get message(): string {
    return `The engine has no project ${this.projectId}.`;
  }
}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId,
}) {
  override get message(): string {
    return `The engine has no session ${this.sessionId}.`;
  }
}

/** A `start` delivery reached a session that is running or has queued turns. */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  sessionId: SessionId,
  turnId: TurnId,
}) {
  override get message(): string {
    return `The session ${this.sessionId} is busy with turn ${this.turnId}.`;
  }
}

/** A `steer` delivery named a turn that has already ended. Nothing was sent. */
export class TurnNotRunning extends Schema.TaggedError<TurnNotRunning>()("TurnNotRunning", {
  turnId: TurnId,
}) {
  override get message(): string {
    return `The turn ${this.turnId} is not running.`;
  }
}

/** The approval or question was already answered, or expired with its turn. */
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

/** Every engine command can fail this way. */
export const EngineDown = Schema.Union([EngineUnavailable, EngineIncompatible]);
export type EngineDown = typeof EngineDown.Type;
