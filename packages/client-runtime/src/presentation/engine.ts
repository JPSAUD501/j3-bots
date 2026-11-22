// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus } from "@j3-bots/contracts";

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

/**
 * What holds a bot's hello back, as the server holds it: the engine reports
 * the bot's provider, and not as ready. `connect` when a command connects it.
 * Null while nothing does: the hello is on its way, or already said.
 */
export const openingHeld = (
  bot: Bot,
  engine: EngineStatus | null,
):
  | { readonly _tag: "connect"; readonly command: string }
  | { readonly _tag: "provider" }
  | null => {
  if (!bot.opening || engine === null) return null;
  const provider = engine.providers.find((p) => p.id === bot.model.providerId);
  if (provider === undefined || provider.status._tag === "ready") return null;
  return provider.status._tag === "sign-in-required"
    ? { _tag: "connect", command: provider.status.command }
    : { _tag: "provider" };
};
