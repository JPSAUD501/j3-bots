// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BotId, Label, ModelId, NonNegativeInt, ProviderId, RoutineId } from "./base.ts";
import type { ModelChoice, PermissionMode } from "./bot.ts";

export const UsageWindow = Schema.Struct({
  /**
   * As the engine words it, such as "Session" (a five-hour window), "Weekly"
   * or "Weekly · <model>".
   */
  label: Label,
  usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type UsageWindow = typeof UsageWindow.Type;

/**
 * One shell command the operator runs, as shown, on the machine that hosts J3
 * Bots, such as the command that connects the providers to the endpoint that
 * serves their models.
 */
export const HostCommand = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));

export const ProviderStatus = Schema.Struct({
  id: ProviderId,
  name: Label,
  /** Which harness it runs. */
  harness: Schema.Literals(["claude-code", "codex", "other"]),
  status: Schema.Union([
    Schema.TaggedStruct("ready", {}),
    /**
     * Not connected: the harness has no way to reach its models yet. J3 Bots
     * connects its providers to an endpoint on the host, so the server says
     * which command does that. It is the same command for every provider.
     */
    Schema.TaggedStruct("sign-in-required", { command: HostCommand }),
    Schema.TaggedStruct("limited", { resetsAt: Schema.NullOr(Schema.DateTimeUtc) }),
    /**
     * It cannot run a bot now. `checking` when that is only because the engine
     * has not finished its first check of it since it started, which can take
     * up to a minute: the state that check finds replaces this one. A check
     * still not ended a minute and a half after the engine became ready has
     * failed, and the provider is then `unavailable` without `checking`. A
     * server older than `checking` answers without it, at the same protocol
     * version, and reads as not checking; an older client ignores it.
     */
    Schema.TaggedStruct("unavailable", {
      checking: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
  ]),
  models: Schema.Array(Schema.Struct({ id: ModelId, name: Label })),
  usage: Schema.Array(UsageWindow),
});
export type ProviderStatus = typeof ProviderStatus.Type;

/**
 * How far the download of the pinned engine has come, on the server's first
 * start or the first after an update: `receivedBytes` of `totalBytes`, which
 * is null when the download does not say its size. A resumed download counts
 * what it had before. The server updates it at most about once a second.
 */
export const EngineInstallProgress = Schema.Struct({
  receivedBytes: NonNegativeInt,
  totalBytes: Schema.NullOr(NonNegativeInt),
});
export type EngineInstallProgress = typeof EngineInstallProgress.Type;

/**
 * Whether the engine's browser can run on the machine that hosts J3 Bots, as
 * far as the server could tell: what a bot given the browser needs first.
 * `setup-required` says what is missing: a sandbox the system allows, the
 * libraries the browser loads, fonts. `j3-bots doctor` on that machine gives
 * the one command, run once by an administrator, that sets them up.
 * Libraries are known only once the engine has downloaded the browser, the
 * first time a bot uses it.
 */
export const BrowserHostStatus = Schema.Union([
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("setup-required", {
    needs: Schema.Array(Schema.Literals(["sandbox", "libraries", "fonts"])),
  }),
]);
export type BrowserHostStatus = typeof BrowserHostStatus.Type;

export const EngineStatus = Schema.Struct({
  state: Schema.Union([
    /**
     * Not ready yet. `install` while the pinned engine is downloading, and
     * absent once it is installed (or was already). A server older than
     * `install` never sends it, at the same protocol version, and an older
     * client ignores it.
     */
    Schema.TaggedStruct("starting", { install: Schema.optionalKey(EngineInstallProgress) }),
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
  /**
   * Whether the browser can run here, once the engine is ready and has
   * checked; absent before that. A server older than `browser` never sends
   * it, at the same protocol version, and an older client ignores it.
   */
  browser: Schema.optionalKey(BrowserHostStatus),
});
export type EngineStatus = typeof EngineStatus.Type;

/**
 * The permission mode of a bot created without one, in `status`: supervised
 * unless the provider is known to take Auto. The engine's reviewer exists on
 * Claude Code and Codex; **Assumed** for any other harness.
 */
export const defaultPermissionMode = (status: EngineStatus, model: ModelChoice): PermissionMode => {
  const provider = status.providers.find((candidate) => candidate.id === model.providerId);
  return provider !== undefined && provider.harness !== "other" ? "auto" : "supervised";
};

/** The routine whose run a turn was part of. */
export const UsageRoutine = Schema.Union([
  /** The routine, with the name it has now. */
  Schema.TaggedStruct("routine", { id: RoutineId, name: Label }),
  /** The routine was deleted since. */
  Schema.TaggedStruct("deleted", {}),
]);
export type UsageRoutine = typeof UsageRoutine.Type;

/** The most turns one read of `usage.turns` returns. */
export const MAX_USAGE_TURNS = 1_000;

/** How far back `usage.turns` reads, from the moment the server reads. */
export const USAGE_PERIOD = Duration.days(1);

/** A turn that ran recently, for the usage view. */
export const UsageTurn = Schema.Struct({
  botId: BotId,
  /** Set when a routine run caused the turn; null for the bot's other turns. */
  routine: Schema.NullOr(UsageRoutine),
  providerId: ProviderId,
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type UsageTurn = typeof UsageTurn.Type;
