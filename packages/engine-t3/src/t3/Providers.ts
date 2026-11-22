// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, type ProviderStatus } from "@j3-bots/contracts";
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
 * `db51b67`, `server.ts`), member for member, with the two that carry the
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
 * sends every change as a whole list (**Read** at `db51b67`, `rpc.ts`,
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

const unavailable = { _tag: "unavailable", checking: false } as const;
const checking = { _tag: "unavailable", checking: true } as const;

/**
 * Whether the report is the one the engine publishes for a Claude Code or
 * Codex instance before its first check since the engine started: enabled,
 * not installed, a `warning` and its sign-in `unknown`. A check that does not
 * find the harness reports an `error` instead, and one that finds it signed
 * out reports `unauthenticated`. **Read** at `59651c1`,
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
 * only when something asks for it (**Read** at `59651c1`,
 * `makeManagedServerProvider` in `provider-core/src/server/managedProvider.ts`,
 * `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL` in `contracts/src/settings.ts`).
 * A check that ends takes at most 45 seconds: Claude Code's version check
 * allows 20 and its capabilities probe 25, Codex's probe 20 (**Read** at
 * `59651c1`, `ClaudeProvider.ts` and `CodexProvider.ts`). Past the budget, the
 * placeholder is `unavailable` without `checking`.
 */
const FIRST_CHECK_BUDGET = Duration.seconds(90);

/**
 * Each engine state, with whether the engine is within its first-check
 * budget: from each time it becomes ready until `FIRST_CHECK_BUDGET` passes,
 * when the same state comes again without it, so what depends on the budget
 * changes without a new report from the engine. `states` emits a state only
 * when its tag changes, as `stateChanges` does.
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
 * The models the engine offers on an instance. A model whose id J3 Bots
 * cannot hold (over 128 characters) is left out rather than cut, since a cut
 * id would name another model or none.
 */
const modelsOf = (engine: ReportedProvider | undefined): ProviderStatus["models"] =>
  (engine?.models ?? []).flatMap((model) =>
    Option.match(decodeModelId(model.slug), {
      onNone: () => [],
      onSome: (id) => [{ id, name: model.name.slice(0, 200) }],
    }),
  );

/**
 * Whether the engine's instance can run a bot, in J3 Bots' terms:
 * - not checked yet since the engine started (`notCheckedYet`), within the
 *   first-check budget: `unavailable`, `checking`;
 * - missing from the engine's list (not provisioned yet), disabled, not
 *   installed or unavailable: `unavailable`;
 * - signed out: `sign-in-required`, with the command that connects Claude
 *   Code and Codex to an endpoint (an ACP agent has no such command, and is
 *   `unavailable`);
 * - in error: `unavailable`;
 * - otherwise `ready`. A harness reached through an endpoint's key reports
 *   its sign-in as `unknown` or authenticated; its first turn says whether
 *   the key works. **Read** at `db51b67`, `ServerProvider` in `server.ts`.
 */
const statusOf = (
  provider: ProviderInstance,
  engine: ReportedProvider | undefined,
  firstCheck: boolean,
): ProviderStatus["status"] => {
  if (engine !== undefined && notCheckedYet(provider, engine)) {
    return firstCheck ? checking : unavailable;
  }
  if (
    engine === undefined ||
    !engine.enabled ||
    !engine.installed ||
    engine.availability === "unavailable"
  ) {
    return unavailable;
  }
  if (engine.auth.status === "unauthenticated") {
    return provider.harness === "acp-command"
      ? unavailable
      : { _tag: "sign-in-required", command: CONNECT_COMMAND };
  }
  return engine.status === "disabled" || engine.status === "error"
    ? unavailable
    : { _tag: "ready" };
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
 * and the reset when it gives one (**Read** at `db51b67`,
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

/**
 * Each of J3 Bots' providers as the engine reports its instance, in the order
 * J3 Bots lists them. `firstCheck`: the engine is within its first-check
 * budget (`withFirstCheckBudget`).
 */
export const providerStatuses = (
  providers: ReadonlyArray<ProviderInstance>,
  engine: ReadonlyArray<ReportedProvider>,
  firstCheck: boolean,
): ReadonlyArray<ProviderStatus> =>
  providers.map((provider) => {
    const reported = engine.find(
      (candidate) => candidate.instanceId === instanceIdFor(provider.id),
    );
    return {
      id: provider.id,
      name: provider.name,
      harness: provider.harness === "acp-command" ? "other" : provider.harness,
      status: statusOf(provider, reported, firstCheck),
      models: modelsOf(reported),
      usage: usageOf(reported),
    };
  });
