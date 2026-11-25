// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type EngineStatus,
  type ProviderStatus,
  signInHarnesses,
  type UnavailableReason,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";

/** A provider a bot can be created on: ready, with a model to pick. */
const canRunBots = (provider: ProviderStatus): boolean =>
  provider.status._tag === "ready" && provider.models.length > 0;

/**
 * Whether the server has a model for a bot created without one: a provider
 * that lists one and may still run it, as the server picks a default (one the
 * engine checked and cannot run is never it). False before the engine reports.
 */
export const hasDefaultModel = (engine: EngineStatus | null): boolean =>
  engine !== null &&
  engine.providers.some(
    (provider) =>
      provider.models.length > 0 &&
      !(provider.status._tag === "unavailable" && !provider.status.checking),
  );

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
 * What holds a bot's hello back, as the server holds it: the engine does not
 * report the bot's provider as ready.
 * - `connect`: a command connects a provider: the bot's own, signed out, or
 *   another when the bot's own cannot run at all (unavailable, and no longer
 *   being checked), which a bot on the server's default model moves to;
 * - `limit`: the bot's provider is at its usage limit, which resets at
 *   `resetsAt` when that is known;
 * - `provider`: anything else, such as a provider still being checked, or one
 *   the engine does not report.
 */
export type OpeningHold =
  | { readonly _tag: "connect"; readonly command: string }
  | { readonly _tag: "limit"; readonly resetsAt: DateTime.Utc | null }
  | { readonly _tag: "provider" };

/**
 * What holds the bot's hello back now (`OpeningHold`). Null while nothing
 * does: the hello is on its way or already said, or the engine's status is
 * not known yet.
 */
export const openingHeld = (bot: Bot, engine: EngineStatus | null): OpeningHold | null => {
  if (!bot.opening || engine === null) return null;
  const provider = engine.providers.find((p) => p.id === bot.model.providerId);
  if (provider === undefined) return { _tag: "provider" };
  switch (provider.status._tag) {
    case "ready":
      return null;
    case "sign-in-required":
      return { _tag: "connect", command: provider.status.command };
    case "limited":
      return { _tag: "limit", resetsAt: provider.status.resetsAt };
    case "unavailable": {
      if (provider.status.checking) return { _tag: "provider" };
      const command = connectCommand(engine);
      return command === null ? { _tag: "provider" } : { _tag: "connect", command };
    }
  }
};

/**
 * What the operator does about a provider the engine is done checking and
 * cannot run, from its line:
 * - `install`: its harness is not installed where the server runs. `page` is
 *   where its maker says how, when J3 Bots knows it; once it is installed,
 *   the engine looks again (`engine.recheckProvider`);
 * - `retry`: it was found and failed; the engine checks it again.
 * Null for any other state: one that runs or is being checked, a signed-out
 * provider (which the step's own sign-in or command connects), one turned
 * off on the server, which no client turns on, and one whose server gives no
 * reason, which also does not take `engine.recheckProvider`.
 */
export type ProviderFix =
  | { readonly _tag: "install"; readonly page: string | null }
  | { readonly _tag: "retry" };

export const providerFix = (provider: ProviderStatus): ProviderFix | null => {
  const { status } = provider;
  return status._tag === "unavailable" && !status.checking
    ? fixFor(status.reason, provider.harness)
    : null;
};

const fixFor = (
  reason: UnavailableReason | undefined,
  harness: ProviderStatus["harness"],
): ProviderFix | null => {
  switch (reason) {
    case "not-installed":
      return {
        _tag: "install",
        page: harness === "other" ? null : signInHarnesses[harness].installPage,
      };
    case "failed":
      return { _tag: "retry" };
    case "disabled":
    case "unknown":
    case undefined:
      return null;
  }
};
