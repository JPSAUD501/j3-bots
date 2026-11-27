// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_LABEL_LENGTH,
  MAX_PROVIDER_DETAIL,
  ModelId,
  type ProviderId,
  type ProviderStatus,
  type ProviderUpdate,
  type ProviderVersion,
  type UnavailableReason,
} from "@j3-bots/contracts";
import {
  ForwardCompatibleArray,
  ServerConfig,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusDeltasEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
  ServerProvider,
  ServerProviderUsageWindow,
  WsSubscribeServerConfigRpc,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as RpcSchema from "effect/rpc/RpcSchema";
import type { ProviderInstance } from "../Engine.ts";
import { effortsOf } from "./Effort.ts";
import { instanceIdFor } from "./Provision.ts";

/**
 * What the operator runs on the host to give Claude Code and Codex a way to
 * their models. It runs as typed: it asks for the endpoint's base URL and its
 * key, and hands both to the server (`Engine.connectProviders`).
 */
export const CONNECT_COMMAND = "j3-bots provider connect";

/**
 * An instance as the engine reports it, with its usage limits left as sent.
 * The engine's own list drops a whole instance whose report does not decode,
 * so a malformed usage window, which is telemetry, would cost the instance its
 * status; the adapter decodes the limits apart instead (`usageOf`).
 */
const ReportedProvider = ServerProvider.mapFields(
  Struct.assign({ usageLimits: Schema.optional(Schema.Unknown) }),
);
export type ReportedProvider = typeof ReportedProvider.Type;

const ReportedProviders = ForwardCompatibleArray(ReportedProvider);

/**
 * The engine's config stream event (`ServerConfigStreamEvent`, **Read** at
 * `bc0f04d`, `server.ts`), member for member, with the two that carry the
 * provider list reading it as `ReportedProvider`s.
 */
export const ConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent.mapFields(
    Struct.assign({
      config: ServerConfig.mapFields(Struct.assign({ providers: ReportedProviders })),
    }),
  ),
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent.mapFields(
    Struct.assign({ payload: Schema.Struct({ providers: ReportedProviders }) }),
  ),
  ServerConfigStreamProviderStatusDeltasEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type ConfigStreamEvent = typeof ConfigStreamEvent.Type;

/** The engine's `subscribeServerConfig`, streaming `ConfigStreamEvent`s. */
export const SubscribeServerConfigRpc = WsSubscribeServerConfigRpc.setSuccess(
  RpcSchema.Stream(ConfigStreamEvent, WsSubscribeServerConfigRpc.successSchema.error),
);

/**
 * The providers the engine reports, from a config stream event: the whole
 * list, on a snapshot or a status change. Other events say nothing about
 * them. The adapter subscribes without `providerStatusDeltas`, so the engine
 * sends every change as a whole list (**Read** at `bc0f04d`, `rpc.ts`,
 * `WsSubscribeServerConfigRpc`).
 */
export const providersOfEvent = (
  event: ConfigStreamEvent,
): ReadonlyArray<ReportedProvider> | undefined => {
  switch (event.type) {
    case "snapshot":
      return event.config.providers;
    case "providerStatuses":
      return event.payload.providers;
    default:
      return undefined;
  }
};

const checking = { _tag: "unavailable", checking: true } as const;
const unavailable = (reason: UnavailableReason, detail?: string) =>
  ({
    _tag: "unavailable",
    checking: false,
    reason,
    ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_PROVIDER_DETAIL) }),
  }) as const;

/**
 * Whether the report is the one the engine publishes for a Claude Code or
 * Codex instance before its first check since the engine started: enabled,
 * not installed, a `warning` and its sign-in `unknown`. A check that does not
 * find the harness reports an `error` instead, and one that finds it signed
 * out reports `unauthenticated`. **Read** at `bc0f04d`,
 * `makePendingClaudeProvider` in `ClaudeProvider.ts` and
 * `makePendingCodexProvider` in `CodexProvider.ts`, published first by
 * `makeManagedServerProvider` in `provider-core/src/server/managedProvider.ts`.
 * An ACP agent is left out: the engine reports the same for one it checked
 * and found not set up or not prepared (`acpRegistrySnapshotReadiness`).
 */
const notCheckedYet = (provider: ProviderInstance, engine: ReportedProvider) =>
  provider.harness !== "acp-command" &&
  engine.enabled &&
  !engine.installed &&
  engine.status === "warning" &&
  engine.auth.status === "unknown";

/**
 * How long after the engine becomes ready its placeholder still counts as a
 * first check under way. The engine starts that check in the background once
 * it is ready and ignores its failure: a check that fails or dies leaves the
 * placeholder until the periodic refresh, five minutes later by default and
 * only when something asks for it (**Read** at `bc0f04d`,
 * `makeManagedServerProvider` in `provider-core/src/server/managedProvider.ts`,
 * `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL` in `contracts/src/settings.ts`).
 * A check that ends takes at most 45 seconds: Claude Code's version check
 * allows 20 and its capabilities probe 25, Codex's probe 20 (**Read** at
 * `bc0f04d`, `ClaudeProvider.ts` and `CodexProvider.ts`). Past the budget, the
 * placeholder is `unavailable` without `checking`.
 */
export const FIRST_CHECK_BUDGET = Duration.seconds(90);

/**
 * The version number in a version the engine reports: the whole of it, as
 * Codex's (the part of its user agent after the slash, **Read** at
 * `bc0f04d`, `CodexProvider.ts`), or the first `x.y.z` in it, with its
 * prerelease, as in what `claude --version` prints.
 */
export const versionNumberIn = (reported: string | null | undefined): string | null =>
  /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(reported ?? "")?.[1] ?? null;

/**
 * Each engine state, with whether the engine is within its first-check
 * budget: from each time it becomes ready until `FIRST_CHECK_BUDGET` passes,
 * when the same state comes again without it, so what depends on the budget
 * changes without a new report from the engine. `states` emits a state only
 * when it changes, as `stateChanges` does.
 */
export const withFirstCheckBudget = <S extends { readonly _tag: string }, E, R>(
  states: Stream.Stream<S, E, R>,
): Stream.Stream<{ readonly state: S; readonly firstCheck: boolean }, E, R> =>
  states.pipe(
    Stream.switchMap((state) =>
      state._tag === "ready"
        ? Stream.concat(
            Stream.succeed({ state, firstCheck: true }),
            Stream.fromEffect(
              Effect.as(Effect.sleep(FIRST_CHECK_BUDGET), { state, firstCheck: false }),
            ),
          )
        : Stream.succeed({ state, firstCheck: false }),
    ),
  );

const decodeModelId = Schema.decodeUnknownOption(ModelId);

/**
 * The models the engine offers on an instance, each with the levels of effort
 * it takes (`effortsOf`). A model whose id J3 Bots cannot hold (over 128
 * characters) is left out rather than cut, since a cut id would name another
 * model or none.
 */
const modelsOf = (engine: ReportedProvider | undefined): ProviderStatus["models"] =>
  (engine?.models ?? []).flatMap((model) =>
    Option.match(decodeModelId(model.slug), {
      onNone: () => [],
      onSome: (id) => [
        {
          id,
          name: model.name.slice(0, MAX_LABEL_LENGTH),
          efforts: effortsOf(model),
          ...(model.isCustom ? { custom: true as const } : {}),
        },
      ],
    }),
  );

/**
 * What the engine words a check of Claude Code or Codex with when it did not
 * answer in time: "Timed out while checking Codex app-server provider
 * status." and "Claude Agent CLI is installed but failed to run. Timed out
 * while running command." (**Read** at `bc0f04d`, `CodexProvider.ts` and
 * `ClaudeProvider.ts`). The engine reports no other sign of it.
 */
const TIMED_OUT = /\btimed out\b/i;

/**
 * Whether the engine's last check of the instance timed out, which a machine
 * busy starting everything can cause, and which the engine does not try again
 * on its own (`FIRST_CHECK_BUDGET` says when it does): a check that found the
 * harness and reported an error in the engine's words for a timeout
 * (`TIMED_OUT`), or a first check still not ended past its budget. A check
 * that failed for another reason, or did not find the harness, did not time
 * out. An ACP agent's check is J3 Bots' own command, so neither applies.
 */
export const checkTimedOut = (
  provider: ProviderInstance,
  engine: ReportedProvider | undefined,
  firstCheck: boolean,
): boolean => {
  if (engine === undefined || provider.harness === "acp-command") return false;
  if (notCheckedYet(provider, engine)) return !firstCheck;
  // An instance the engine could not create reports itself neither enabled nor installed.
  return (
    engine.enabled &&
    engine.installed &&
    engine.status === "error" &&
    TIMED_OUT.test(engine.message ?? "")
  );
};

/**
 * Whether the engine's instance can run a bot, in J3 Bots' terms:
 * - not checked yet since the engine started (`notCheckedYet`): within the
 *   first-check budget, `unavailable` and `checking`; past it, the check
 *   failed or died, `failed`;
 * - turned off, in J3 Bots' provisioning or the engine's settings (not
 *   enabled, or a `disabled` state): `disabled`;
 * - an instance the engine could not create at all (`availability:
 *   "unavailable"`, which it reports neither installed nor enabled), as for
 *   settings it cannot read or a driver that failed to start: `failed`
 *   (**Read** at `bc0f04d`, `unavailableProviderSnapshot.ts`), checked
 *   before the instance's own `enabled`;
 * - not found, which the engine reports as not installed: `not-installed`;
 * - missing from the engine's list, as before it was provisioned or when its
 *   report did not decode: `failed`;
 * - signed out: `sign-in-required`, with the command that connects Claude
 *   Code and Codex to an endpoint (an ACP agent has no such command, and is
 *   `failed`);
 * - in error, as a check that found the harness but could not run it, or
 *   timed out (**Read** at `bc0f04d`, `ClaudeProvider.ts`): `failed`;
 * - otherwise `ready`. A harness reached through an endpoint's key reports
 *   its sign-in as `unknown` or authenticated; its first turn says whether
 *   the key works. **Read** at `bc0f04d`, `ServerProvider` in `server.ts`.
 *
 * The engine's own words go with `not-installed` and `failed` as `detail`,
 * cut to what J3 Bots holds: its `message`, or for an instance it could not
 * create its `unavailableReason`. Its placeholder's say only that it has not
 * checked, and a turned-off instance's name the engine's settings, which J3
 * Bots provisions, so neither goes.
 */
const statusOf = (
  provider: ProviderInstance,
  engine: ReportedProvider | undefined,
  firstCheck: boolean,
): ProviderStatus["status"] => {
  if (engine === undefined) return unavailable("failed");
  if (notCheckedYet(provider, engine)) return firstCheck ? checking : unavailable("failed");
  if (engine.availability === "unavailable") {
    return unavailable("failed", engine.unavailableReason ?? engine.message);
  }
  if (!engine.enabled || engine.status === "disabled") return unavailable("disabled");
  if (!engine.installed) return unavailable("not-installed", engine.message);
  if (engine.auth.status === "unauthenticated") {
    return provider.harness === "acp-command"
      ? unavailable("failed", engine.message)
      : { _tag: "sign-in-required", command: CONNECT_COMMAND };
  }
  return engine.status === "error" ? unavailable("failed", engine.message) : { _tag: "ready" };
};

const decodeUsageLimits = Schema.decodeUnknownOption(
  Schema.Struct({ windows: Schema.Array(Schema.Unknown) }),
);
const decodeWindow = Schema.decodeUnknownOption(ServerProviderUsageWindow);

/** An ISO 8601 date and time with its offset, to the minute or finer. */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const daysIn = (year: number, month: number): number => {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/**
 * The instant a reset names, when it is a well-formed ISO 8601 timestamp
 * (the engine's `IsoDateTime` is any string). Anything else, as `"0"` or a
 * day the month does not have, is no instant rather than one the calendar
 * rolls over to.
 */
const resetOf = (text: string): DateTime.Utc | null => {
  const match = ISO_INSTANT.exec(text);
  if (match === null) return null;
  // Seconds and an offset left out are zero.
  const part = (index: number) => Number(match[index] ?? 0);
  const [year, month, day] = [part(1), part(2), part(3)];
  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    part(4) <= 23 &&
    part(5) <= 59 &&
    part(6) <= 59 &&
    part(7) <= 23 &&
    part(8) <= 59;
  return valid ? Option.getOrNull(DateTime.make(text)) : null;
};

/**
 * The usage windows the engine reports for an instance, in its order (by
 * kind, then id), with their labels as it words them: percent used, 0 to 100,
 * and the reset when it gives one (**Read** at `bc0f04d`,
 * `ServerProviderUsageLimits` in `providerUsageLimits.ts`). The windows it
 * kept after a failed check count; an instance it reads no usage for, as one
 * reached through a provider connection, has none (**Verified** on release
 * `4969`). A window that does not decode is left out, and limits with no list
 * of windows count as none: usage never costs an instance its status. A label
 * longer than J3 Bots holds is cut, as a model's name is.
 */
const usageOf = (engine: ReportedProvider | undefined): ProviderStatus["usage"] =>
  Option.match(decodeUsageLimits(engine?.usageLimits), {
    onNone: () => [],
    onSome: (limits) =>
      limits.windows.flatMap((raw) =>
        Option.match(decodeWindow(raw), {
          onNone: () => [],
          onSome: (window) => [
            {
              label: window.label.slice(0, 200),
              usedPercent: window.usedPercent,
              resetsAt: window.resetsAt === undefined ? null : resetOf(window.resetsAt),
            },
          ],
        }),
      ),
  });

/** A version the engine gave, when it fits a label. */
const versionLabel = (version: string | null | undefined): string | null =>
  version === null || version === undefined || version.length > MAX_LABEL_LENGTH ? null : version;

/**
 * The version of the harness the engine found, on the terms T3 Code's own
 * client offers an update in its settings (**Read** at `bc0f04d`,
 * `isProviderSettingsUpdateCandidate` in
 * `apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts`): a
 * newer version is shown only when the engine reports the installed one
 * `behind_latest` and does not report the latest broken or unsupported with
 * the engine; it can be updated when the instance is enabled and the engine
 * says it can, with a command. `installed` is the version the engine's
 * advisory read, else the one its check reported.
 */
const versionOf = (engine: ReportedProvider | undefined): ProviderVersion | undefined => {
  if (engine === undefined || !engine.installed) return undefined;
  const advisory = engine.versionAdvisory;
  const latestStatus = engine.compatibilityAdvisory?.latestVersionStatus;
  const latest =
    advisory?.status === "behind_latest" &&
    latestStatus !== "broken" &&
    latestStatus !== "unsupported"
      ? versionLabel(advisory.latestVersion)
      : null;
  return {
    installed: versionLabel(advisory?.currentVersion ?? engine.version),
    latest,
    canUpdate:
      latest !== null &&
      engine.enabled &&
      advisory?.canUpdate === true &&
      advisory.updateCommand !== null,
  };
};

/**
 * An update the adapter asked the engine for (`engine.updateProvider`), as
 * the adapter knows it, asked at `askedAt` (epoch milliseconds): `asked`
 * until the engine answers the request, and `refused` when the answer was
 * not an update's end: the engine refused to start it, in its words
 * (`detail`), or the request or its answer was lost, with none. A request
 * the engine answered otherwise is forgotten: the engine's own state says
 * how it went.
 */
export type UpdateRequest =
  | { readonly _tag: "asked"; readonly askedAt: number }
  | { readonly _tag: "refused"; readonly askedAt: number; readonly detail: string | null };

const updateDetail = (message: string | null | undefined) =>
  message === null || message === undefined
    ? {}
    : { detail: message.slice(0, MAX_PROVIDER_DETAIL) };

/**
 * The update last asked for, from the engine's `updateState` (**Read** at
 * `bc0f04d`, `ServerProviderUpdateState` in `contracts/src/server.ts`, set by
 * `ProviderMaintenanceRunner.updateProvider`): `queued` and `running` are
 * `running`; `succeeded`, which the engine also reports for a harness that
 * was already up to date, is `updated`; `unchanged`, which it reports when
 * the command ran but its check did not confirm a newer version, is
 * `unverified`; `failed` is `failed`; `idle` is none. The adapter's own
 * `request` comes before an update the engine finished before it was asked:
 * one just asked is `running` until the engine reports it, and one refused
 * or lost is `failed`. An update the engine finished since, as one whose
 * answer was lost, is the engine's to tell.
 */
const updateOf = (
  engine: ReportedProvider | undefined,
  request: UpdateRequest | undefined,
): ProviderUpdate | undefined => {
  const state = engine?.updateState;
  if (state?.status === "queued" || state?.status === "running") {
    return { state: "running", ...updateDetail(state.message) };
  }
  const finishedAt = Option.map(
    Option.fromNullishOr(state?.finishedAt).pipe(Option.flatMap(DateTime.make)),
    DateTime.toEpochMillis,
  );
  const finishedSince =
    request !== undefined && Option.isSome(finishedAt) && finishedAt.value >= request.askedAt;
  if (request !== undefined && !finishedSince) {
    return request._tag === "asked"
      ? { state: "running" }
      : { state: "failed", ...updateDetail(request.detail) };
  }
  switch (state?.status) {
    case "succeeded":
      return { state: "updated", ...updateDetail(state.message) };
    case "unchanged":
      return { state: "unverified", ...updateDetail(state.message) };
    case "failed":
      return { state: "failed", ...updateDetail(state.message) };
    case "idle":
    case undefined:
      return undefined;
  }
};

/**
 * Each of J3 Bots' providers as the engine reports its instance, in the order
 * J3 Bots lists them. `firstCheck`: whether the provider is within its
 * first-check budget, since the engine became ready (`withFirstCheckBudget`)
 * or the engine replaced its instance. `rechecks`: when the adapter next
 * checks again a provider whose check timed out (`recheckWhileTimedOut`),
 * which its status carries as `retryAt` while that check still reads as
 * timed out.
 */
export const providerStatuses = (
  providers: ReadonlyArray<ProviderInstance>,
  engine: ReadonlyArray<ReportedProvider>,
  firstCheck: (providerId: ProviderInstance["id"]) => boolean,
  updates: ReadonlyMap<ProviderId, UpdateRequest> = new Map(),
  rechecks: ReadonlyMap<ProviderId, DateTime.Utc> = new Map(),
): ReadonlyArray<ProviderStatus> =>
  providers.map((provider) => {
    const reported = engine.find(
      (candidate) => candidate.instanceId === instanceIdFor(provider.id),
    );
    // An ACP agent is a command J3 Bots runs, not a harness with versions.
    const version = provider.harness === "acp-command" ? undefined : versionOf(reported);
    const update = updateOf(reported, updates.get(provider.id));
    const inBudget = firstCheck(provider.id);
    const status = statusOf(provider, reported, inBudget);
    const retryAt = rechecks.get(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      harness: provider.harness === "acp-command" ? "other" : provider.harness,
      status:
        status._tag === "unavailable" &&
        retryAt !== undefined &&
        checkTimedOut(provider, reported, inBudget)
          ? { ...status, retryAt }
          : status,
      models: modelsOf(reported),
      usage: usageOf(reported),
      ...(version === undefined ? {} : { version }),
      ...(update === undefined ? {} : { update }),
    };
  });

/** What stands in for a secret in the engine's words. */
export const REDACTED = "[redacted]";

/** `text` with every value in `secrets` replaced, the longest first, so a secret that contains another goes whole. */
export const redact = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets
    .filter((secret) => secret.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED), text);

/**
 * The engine's reports with every value in `secrets` taken out of its words
 * (`message`, `unavailableReason`, its update's `message`). What a harness printed when its check
 * failed can be part of them, and the harness runs with the secrets J3 Bots
 * gives it: the provider connection's key and each instance's own
 * variables. Those words reach every paired client and J3 Bots' log.
 */
export const withoutSecrets = (
  providers: ReadonlyArray<ReportedProvider>,
  secrets: ReadonlyArray<string>,
): ReadonlyArray<ReportedProvider> => {
  const known = secrets.filter((secret) => secret.length > 0);
  if (known.length === 0) return providers;
  const scrub = (text: string) => redact(text, known);
  return providers.map((provider) => ({
    ...provider,
    ...(provider.message === undefined ? {} : { message: scrub(provider.message) }),
    ...(provider.unavailableReason === undefined
      ? {}
      : { unavailableReason: scrub(provider.unavailableReason) }),
    ...(provider.updateState?.message === undefined || provider.updateState.message === null
      ? {}
      : { updateState: { ...provider.updateState, message: scrub(provider.updateState.message) } }),
  }));
};

/**
 * What to log of each provider the engine reports it cannot run, keyed by
 * provider: its reason and the engine's words, as the line J3 Bots' log gives
 * it. A provider still being checked, or able to run, has none.
 */
export const providerProblems = (
  providers: ReadonlyArray<ProviderInstance>,
  engine: ReadonlyArray<ReportedProvider>,
): ReadonlyMap<ProviderInstance["id"], string> =>
  new Map(
    providerStatuses(providers, engine, () => true).flatMap(({ id, name, status }) =>
      status._tag === "unavailable" && !status.checking
        ? [
            [
              id,
              `${name}: ${status.reason ?? "unavailable"}${status.detail === undefined ? "" : ` (${status.detail})`}`,
            ] as const,
          ]
        : [],
    ),
  );
