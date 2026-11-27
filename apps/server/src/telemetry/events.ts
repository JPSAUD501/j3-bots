// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  type EngineStatus,
  Invalid,
  NotFound,
  SecretRefused,
  type TelemetryEvent,
  type ModelChoice,
  type ProviderId,
  type TelemetryEffort,
  type TelemetryHarness,
  TelemetryModel,
  type TelemetryTurnOrigin,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { WakeKind } from "../turns/model.ts";

// How the server's own values become an event's properties: always a closed
// set, never a name, an id or text someone wrote.

const providerOf = (status: EngineStatus | null, providerId: ProviderId) =>
  status?.providers.find((provider) => provider.id === providerId);

/** The harness a provider runs; `other` for one the engine does not report. */
export const harnessOf = (status: EngineStatus | null, providerId: ProviderId): TelemetryHarness =>
  providerOf(status, providerId)?.harness ?? "other";

const decodeModel = Schema.decodeUnknownOption(TelemetryModel);
const CUSTOM = TelemetryModel.make("custom");

/**
 * The model as the engine's catalog names it: only a Claude Code or Codex
 * model the engine lists, and does not mark as one someone added. Any other
 * is `custom`, since its id could name a person, a deployment or a file.
 */
export const modelOf = (status: EngineStatus | null, model: ModelChoice): TelemetryModel => {
  const provider = providerOf(status, model.providerId);
  if (provider === undefined || provider.harness === "other") return CUSTOM;
  const listed = provider.models.find((each) => each.id === model.modelId);
  if (listed === undefined || listed.custom === true) return CUSTOM;
  return Option.getOrElse(decodeModel(listed.id), () => CUSTOM);
};

const EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies ReadonlyArray<TelemetryEffort>);

const isNamedEffort = (effort: string): effort is TelemetryEffort => EFFORTS.has(effort);

/** A bot's effort: the harness's own when it chose none, `other` for a level outside the known ones. */
export const effortOf = (effort: string | null): TelemetryEffort =>
  effort === null ? "default" : isNamedEffort(effort) ? effort : "other";

/** A wake's kind, and for a routine's the kind of its trigger. */
export interface WokenBy {
  readonly kind: WakeKind;
  readonly trigger: "schedule" | "once" | "webhook" | "event" | null;
}

/**
 * Where a turn came from, by the first wake it carried: the operator in the
 * bot's conversation, a room, a teammate, a routine, or a routine a
 * connector's event started. A turn with no wake of its own (work handed
 * back, a harness waking itself) or woken by J3 Bots itself is `other`.
 */
export const originOf = (wakes: ReadonlyArray<WokenBy>): TelemetryTurnOrigin => {
  const first = wakes[0];
  if (first === undefined) return "other";
  switch (first.kind) {
    case "user":
      return "conversation";
    case "room":
      return "room";
    case "bot":
      return "teammate";
    case "routine":
      return first.trigger === "event" ? "event" : "routine";
    case "system":
      return "other";
  }
};

/**
 * A request's failure as `request.failed` tells it: the error's tag and the
 * code its contract gives it, for the errors the contract names; `other`
 * for any other.
 */
const isNotFound = Schema.is(NotFound);
const isConflict = Schema.is(Conflict);
const isInvalid = Schema.is(Invalid);
const isSecretRefused = Schema.is(SecretRefused);

type RequestFailed = Extract<TelemetryEvent, { readonly event: "request.failed" }>;

export const requestFailedOf = (error: unknown): RequestFailed => {
  const failed = (properties: RequestFailed["properties"]): RequestFailed => ({
    event: "request.failed",
    properties,
  });
  if (isNotFound(error)) return failed({ error: "NotFound", code: error.resource });
  if (isConflict(error)) return failed({ error: "Conflict", code: error.reason });
  if (isInvalid(error)) return failed({ error: "Invalid", code: error.reason });
  if (isSecretRefused(error)) return failed({ error: "SecretRefused", code: error.problem });
  return failed({ error: "other", code: null });
};
