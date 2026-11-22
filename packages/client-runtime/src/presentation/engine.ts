// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus } from "@j3-bots/contracts";

/** A provider a bot can be created on: ready, with a model to pick. */
const canRunBots = (provider: ProviderStatus): boolean =>
  provider.status._tag === "ready" && provider.models.length > 0;

/** The one command that connects every provider that needs it; null when none does. */
export const connectCommand = (engine: EngineStatus): string | null =>
  engine.providers.flatMap((provider) =>
    provider.status._tag === "sign-in-required" ? [provider.status.command] : [],
  )[0] ?? null;

/**
 * What stands between the operator and a first bot, with the engine running:
 * - `ready`: a provider can run one;
 * - `checking`: none can yet, and the engine has not finished checking one
 *   since it started, so whether any needs connecting is not known yet;
 * - `connect`: one needs connecting, with the command that does it;
 * - `unavailable`: none can, and connecting would not change that.
 */
type ProviderGate =
  | { readonly _tag: "ready" }
  | { readonly _tag: "checking" }
  | { readonly _tag: "connect"; readonly command: string }
  | { readonly _tag: "unavailable" };

export const providerGate = (engine: EngineStatus): ProviderGate => {
  if (engine.providers.some(canRunBots)) return { _tag: "ready" };
  const checking = engine.providers.some(
    (provider) => provider.status._tag === "unavailable" && provider.status.checking,
  );
  if (checking) return { _tag: "checking" };
  const command = connectCommand(engine);
  return command === null ? { _tag: "unavailable" } : { _tag: "connect", command };
};
