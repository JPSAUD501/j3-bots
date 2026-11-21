// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus } from "@j3-bots/contracts";

/** A provider a bot can be created on: ready, with a model to pick. */
export const canRunBots = (provider: ProviderStatus): boolean =>
  provider.status._tag === "ready" && provider.models.length > 0;

/** The one command that connects every provider that needs it; null when none does. */
export const connectCommand = (engine: EngineStatus): string | null =>
  engine.providers.flatMap((provider) =>
    provider.status._tag === "sign-in-required" ? [provider.status.command] : [],
  )[0] ?? null;
