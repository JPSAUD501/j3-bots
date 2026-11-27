// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EffortLevel,
  EngineStatus,
  ModelChoice,
  ModelId,
  ProviderId,
} from "@j3-bots/contracts";
import type * as Schema from "effect/Schema";

/** Where an account stands for a bot that would run on it, in the words `list_models` uses. */
const stateOf = (status: EngineStatus["providers"][number]["status"]): string => {
  switch (status._tag) {
    case "ready":
      return "ready";
    case "sign-in-required":
      return "signed out";
    case "limited":
      return "at its usage limit";
    case "unavailable":
      if (status.checking) return "being checked";
      return status.reason === "disabled" ? "off" : "unavailable";
  }
};

const HARNESS_NAMES = { "claude-code": "Claude Code", codex: "Codex", other: "Other" } as const;

/**
 * What `list_models` answers: each AI account the engine reports, with its
 * models, their effort levels and whether each has a fast mode, and the
 * model the caller runs on.
 */
export const modelListing = (status: EngineStatus, yours: ModelChoice): Schema.Json => ({
  accounts: status.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    harness: HARNESS_NAMES[provider.harness],
    state: stateOf(provider.status),
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      efforts: (model.efforts ?? []).map((effort) => effort.id),
      fast: model.fast === true,
    })),
  })),
  yours: { account: yours.providerId, model: yours.modelId },
});

/** The AI a bot's `create_bot` or `update_bot` names, as `TeammateModel` in its tools. */
export interface TeammateModel {
  readonly account: ProviderId;
  readonly model: ModelId;
  readonly effort?: EffortLevel;
  readonly fast?: boolean;
}

/**
 * The model, effort and fast mode a teammate gets from `chosen`: what it
 * leaves out is the account's default effort, and fast mode off.
 */
export const modelSettingsOf = (chosen: TeammateModel) => ({
  model: { providerId: chosen.account, modelId: chosen.model },
  effort: chosen.effort ?? null,
  fast: chosen.fast === true,
});
