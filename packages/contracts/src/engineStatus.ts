// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, Label, ModelId, ProviderId, RoutineId } from "./base.ts";

export const UsageWindow = Schema.Struct({
  /** As the provider names it, such as "5 hours" or "Weekly". */
  label: Label,
  usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type UsageWindow = typeof UsageWindow.Type;

export const ProviderStatus = Schema.Struct({
  id: ProviderId,
  name: Label,
  /** Which harness it runs, so a client can say how to sign in. */
  harness: Schema.Literals(["claude-code", "codex", "other"]),
  status: Schema.Union([
    Schema.TaggedStruct("ready", {}),
    Schema.TaggedStruct("sign-in-required", {}),
    Schema.TaggedStruct("limited", { resetsAt: Schema.NullOr(Schema.DateTimeUtc) }),
    Schema.TaggedStruct("unavailable", {}),
  ]),
  models: Schema.Array(Schema.Struct({ id: ModelId, name: Label })),
  usage: Schema.Array(UsageWindow),
});
export type ProviderStatus = typeof ProviderStatus.Type;

export const EngineStatus = Schema.Struct({
  state: Schema.Union([
    Schema.TaggedStruct("starting", {}),
    Schema.TaggedStruct("ready", {}),
    /** Not running or not reachable; the server keeps trying. */
    Schema.TaggedStruct("unavailable", {}),
    /** Running, but not the engine version this release of J3 Bots is pinned to. */
    Schema.TaggedStruct("incompatible", { runningVersion: Label }),
  ]),
  /** The engine version this release is pinned to. */
  pinnedVersion: Label,
  providers: Schema.Array(ProviderStatus),
});
export type EngineStatus = typeof EngineStatus.Type;

/** A turn that ran recently, for the usage view. */
export const UsageTurn = Schema.Struct({
  botId: BotId,
  /** Set when a routine run caused the turn. */
  routineId: Schema.NullOr(RoutineId),
  providerId: ProviderId,
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type UsageTurn = typeof UsageTurn.Type;
