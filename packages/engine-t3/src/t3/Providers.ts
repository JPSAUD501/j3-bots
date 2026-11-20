// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, type ProviderStatus } from "@j3-bots/contracts";
import type { ServerConfigStreamEvent, ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProviderInstance } from "../Engine.ts";
import { instanceIdFor } from "./Provision.ts";

/**
 * What the operator runs on the host to give Claude Code and Codex a way to
 * their models: `j3-bots provider connect`, which takes an endpoint and its
 * key (`Engine.connectProviders`).
 */
export const CONNECT_COMMAND = "j3-bots provider connect --base-url <URL>";

/**
 * The providers the engine reports, from a config stream event: the whole
 * list, on a snapshot or a status change. Other events say nothing about
 * them. The adapter subscribes without `providerStatusDeltas`, so the engine
 * sends every change as a whole list (**Read** at `db51b67`, `rpc.ts`,
 * `WsSubscribeServerConfigRpc`).
 */
export const providersOfEvent = (
  event: ServerConfigStreamEvent,
): ReadonlyArray<ServerProvider> | undefined => {
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
const modelsOf = (engine: ServerProvider | undefined): ProviderStatus["models"] =>
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
  engine: ServerProvider | undefined,
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

/** Each of J3 Bots' providers as the engine reports its instance, in the order J3 Bots lists them. */
export const providerStatuses = (
  providers: ReadonlyArray<ProviderInstance>,
  engine: ReadonlyArray<ServerProvider>,
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
      usage: [],
    };
  });
