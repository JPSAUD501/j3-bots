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

/**
 * One shell command the operator runs on the machine that hosts J3 Bots, such
 * as the command that signs a provider's harness in to its own home.
 */
export const HostCommand = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));

export const ProviderStatus = Schema.Struct({
  id: ProviderId,
  name: Label,
  /** Which harness it runs, so a client can say how to sign in. */
  harness: Schema.Literals(["claude-code", "codex", "other"]),
  status: Schema.Union([
    Schema.TaggedStruct("ready", {}),
    /**
     * Not signed in. The engine has no sign-in flow for these harnesses, so the
     * server says which command signs this provider in on the host.
     */
    Schema.TaggedStruct("sign-in-required", { command: HostCommand }),
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
    /**
     * Not running or not reachable; the server keeps trying. `reason` says why:
     * - `down`: the engine is not running or not answering, and is being restarted;
     * - `port-in-use`: another program listens on the engine's port, which J3
     *   Bots leaves alone;
     * - `install-failed`: the pinned engine could not be downloaded or checked;
     * - `credential-refused`: the engine refused J3 Bots' credential, also after
     *   a fresh one was minted.
     */
    Schema.TaggedStruct("unavailable", {
      reason: Schema.Literals(["down", "port-in-use", "install-failed", "credential-refused"]),
    }),
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
