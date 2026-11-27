// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BotId,
  EffortLevel,
  Label,
  ModelId,
  NonNegativeInt,
  OpenLiterals,
  ProviderId,
  RoutineId,
} from "./base.ts";
import type { ModelChoice, PermissionMode } from "./bot.ts";
import { HarnessCopy } from "./harness.ts";
import type { SignInHarness } from "./provider.ts";

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

/**
 * Why a provider the engine is done checking cannot run a bot:
 * - `not-installed`: the engine did not find its harness on the machine J3
 *   Bots runs on;
 * - `failed`: it found the harness, but its check failed or did not end;
 * - `disabled`: the provider is turned off on the server;
 * - `unknown`, as a client reads it: a reason a newer server gives.
 */
export const unavailableReasons = ["not-installed", "failed", "disabled"] as const;
/** The engine's own account of a provider it cannot run, cut to this length. */
export const MAX_PROVIDER_DETAIL = 500;
export const ProviderDetail = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROVIDER_DETAIL),
);
export const UnavailableReason = OpenLiterals(unavailableReasons);
export type UnavailableReason = typeof UnavailableReason.Type;

/**
 * The version of a provider's harness, as the engine reports it, for a
 * harness the engine found:
 * - `installed`, null when the engine did not read it;
 * - `latest`, set only when the engine knows a newer version is out;
 * - `canUpdate`, whether the engine can update it to `latest` itself
 *   (`engine.updateProvider`), the way its maker updates it.
 */
export const ProviderVersion = Schema.Struct({
  installed: Schema.NullOr(Label),
  latest: Schema.NullOr(Label),
  canUpdate: Schema.Boolean,
});
export type ProviderVersion = typeof ProviderVersion.Type;

/**
 * An update of a provider's harness the operator asked for, since the
 * engine started:
 * - `running`: waiting for work that is opening a session to start, or
 *   running;
 * - `updated`: the engine reports the update finished, which it also does
 *   for a harness that was already up to date; it does not always know the
 *   latest version then;
 * - `unverified`: the update command ran, but the check that followed did
 *   not confirm a newer version;
 * - `failed`: it did not finish, or did not start;
 * - `unknown`, as a client reads it: a state a newer server gives.
 * `detail` is how the engine put it, in its own words (English), when it
 * gave any.
 */
export const providerUpdateStates = ["running", "updated", "unverified", "failed"] as const;
export const ProviderUpdate = Schema.Struct({
  state: OpenLiterals(providerUpdateStates),
  detail: Schema.optionalKey(ProviderDetail),
});
export type ProviderUpdate = typeof ProviderUpdate.Type;

/**
 * One level of effort a model takes, with the engine's English name for it
 * (`Label`), which a client shows only for a level it has no words of its own
 * for.
 */
export const EffortChoice = Schema.Struct({ id: EffortLevel, name: Label });
export type EffortChoice = typeof EffortChoice.Type;

/**
 * A model the engine offers on a provider. `efforts`: the levels of effort it
 * takes, lowest first, as the engine reports them; empty for a model that
 * takes no choice of effort. A server older than it, at the same protocol
 * version, leaves it out, which reads as no choice (`modelEfforts`), and an
 * older client ignores it. Optional, not defaulted, so a reply read from an
 * older server is written back as it came (the admin status reply's rule).
 */
export const ProviderModel = Schema.Struct({
  id: ModelId,
  name: Label,
  efforts: Schema.optionalKey(Schema.Array(EffortChoice)),
});
export type ProviderModel = typeof ProviderModel.Type;

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
     *
     * `reason`, when not `checking`, says why (`UnavailableReason`), and
     * `detail` how the engine put it, in its own words (English), when it
     * gave any: for the operator to read, never to act on. A server older
     * than `reason` answers without either, at the same protocol version, and
     * a client then knows only that the provider cannot run; it also does not
     * answer `engine.recheckProvider`. An older client ignores both.
     *
     * `retryAt`, with `failed`, when its last check timed out, as one run
     * while the machine was busy starting: the server has the engine check it
     * again on its own, and this is when it next does, 15 seconds after the
     * check that timed out, then 30, then a minute, then every five minutes
     * until a check does not time out. A time already passed means that check
     * is under way. Absent for any other failure, which stays as it is until
     * the operator acts, and from a server older than it, at the same
     * protocol version, which does not check again on its own. An older
     * client ignores it.
     */
    Schema.TaggedStruct("unavailable", {
      checking: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      reason: Schema.optionalKey(UnavailableReason),
      detail: Schema.optionalKey(ProviderDetail),
      retryAt: Schema.optionalKey(Schema.DateTimeUtc),
    }),
  ]),
  models: Schema.Array(ProviderModel),
  usage: Schema.Array(UsageWindow),
  /**
   * Its harness's version (`ProviderVersion`), absent when the engine did
   * not find the harness, and from a server older than it, at the same
   * protocol version, which also does not answer `engine.updateProvider`. An
   * older client ignores it.
   */
  version: Schema.optionalKey(ProviderVersion),
  /** The update last asked for (`ProviderUpdate`), absent before one; as `version` for older peers. */
  update: Schema.optionalKey(ProviderUpdate),
  /**
   * For Claude Code and Codex, from a server that installs and updates its
   * own copy of a harness (`HarnessCopy`): where the harness comes from, and
   * an install or update under way. A server older than `copy` never sends
   * it, at the same protocol version, and a client then offers neither an
   * install nor an update; an older client ignores it.
   */
  copy: Schema.optionalKey(HarnessCopy),
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
 * Why the last try to install the pinned engine failed, while the server
 * waits to try again (`install-failed`):
 * - `unsupported-platform`: the engine has no release for this machine;
 * - `download`: its download could not be read, or was cut off;
 * - `checksum`: what arrived is not the archive J3 Bots pins;
 * - `extract`: the archive did not unpack;
 * - `storage`, `in-use`, `permission`, `outside-home`, `files`: a file
 *   could not be written, as for a harness (`HarnessInstallFailure`): only
 *   `storage` is a full disk;
 * - `unknown`, as a client reads it: a reason a newer server gives.
 */
export const engineInstallFailures = [
  "unsupported-platform",
  "download",
  "checksum",
  "extract",
  "storage",
  "in-use",
  "permission",
  "outside-home",
  "files",
] as const;
export const EngineInstallFailure = OpenLiterals(engineInstallFailures);
export type EngineInstallFailure = typeof EngineInstallFailure.Type;

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
     * - `install-failed`: the pinned engine could not be installed; the server
     *   tries again, and `installFailure` says why the last try failed. A
     *   server older than `installFailure` never sends it, at the same
     *   protocol version, and an older client ignores it;
     * - `credential-refused`: the engine refused J3 Bots' credential, also after
     *   a fresh one was minted.
     */
    Schema.TaggedStruct("unavailable", {
      reason: Schema.Literals(["down", "port-in-use", "install-failed", "credential-refused"]),
      installFailure: Schema.optionalKey(EngineInstallFailure),
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
  /**
   * J3 Bots' own copy of each harness (`HarnessCopy`), from a server that
   * installs them, at every state of the engine: the providers carry it
   * only once the engine is ready, and the copies start downloading with
   * the engine, as the server starts. With `state.starting.install`, it is
   * all a first run waits to download. A server older than it never sends
   * it, at the same protocol version, and an older client ignores it.
   */
  harnesses: Schema.optionalKey(Schema.Struct({ "claude-code": HarnessCopy, codex: HarnessCopy })),
});
export type EngineStatus = typeof EngineStatus.Type;

/** Each harness's copy, by harness, as `EngineStatus.harnesses` carries it. */
export type HarnessCopies = Readonly<Record<SignInHarness, HarnessCopy>>;

/**
 * The permission mode of a bot created without one, in `status`: supervised
 * unless the provider is known to take Auto. The engine's reviewer exists on
 * Claude Code and Codex; **Assumed** for any other harness.
 */
export const defaultPermissionMode = (status: EngineStatus, model: ModelChoice): PermissionMode => {
  const provider = status.providers.find((candidate) => candidate.id === model.providerId);
  return provider !== undefined && provider.harness !== "other" ? "auto" : "supervised";
};

/**
 * The levels of effort `model` takes, as `status` reports them; null while the
 * engine does not list the model, whose levels are then not known, and none
 * from a server that does not report levels.
 */
export const modelEfforts = (
  status: EngineStatus,
  model: ModelChoice,
): ReadonlyArray<EffortChoice> | null => {
  const listed = status.providers
    .find((provider) => provider.id === model.providerId)
    ?.models.find((candidate) => candidate.id === model.modelId);
  return listed === undefined ? null : (listed.efforts ?? []);
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
