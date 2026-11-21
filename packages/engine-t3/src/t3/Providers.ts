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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

const unavailable = { _tag: "unavailable" } as const;

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
): ProviderStatus["status"] => {
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

/** Each of J3 Bots' providers as the engine reports its instance, in the order J3 Bots lists them. */
export const providerStatuses = (
  providers: ReadonlyArray<ProviderInstance>,
  engine: ReadonlyArray<ReportedProvider>,
): ReadonlyArray<ProviderStatus> =>
  providers.map((provider) => {
    const reported = engine.find(
      (candidate) => candidate.instanceId === instanceIdFor(provider.id),
    );
    return {
      id: provider.id,
      name: provider.name,
      harness: provider.harness === "acp-command" ? "other" : provider.harness,
      status: statusOf(provider, reported),
      models: modelsOf(reported),
      usage: usageOf(reported),
    };
  });
