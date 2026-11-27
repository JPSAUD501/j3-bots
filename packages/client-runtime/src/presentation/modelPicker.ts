// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EffortChoice,
  type EffortLevel,
  type EngineStatus,
  type ModelChoice,
  modelEfforts,
  modelOffersFast,
  type ProviderStatus,
} from "@j3-bots/contracts";
import type { FavoriteChanges, SettingsSave } from "../stores/Settings.ts";
import { aiAccountNames } from "./aiAccount.ts";
import { sameModel } from "./botEdit.ts";

// Choosing the AI a bot runs on, as T3 Code's picker lets one choose
// (decision 0108): a rail of the accounts, with the starred models first, a
// search over every model, the levels of effort of the model beside it, and
// Standard or Fast below. The same on every client; each draws it its own way.

/** What a bot runs on: an account's model, its effort, and fast mode. */
export interface ModelSetting {
  readonly model: ModelChoice;
  /** A level of the model, or null for the harness's default. */
  readonly effort: EffortLevel | null;
  readonly fast: boolean;
}

/**
 * Where an account stands for the picker:
 * - `ready`: a bot on it runs now;
 * - `limited`: it is at its plan's limit, and runs again once that resets;
 * - `signed-out`: nobody is signed in to it;
 * - `off`: the operator turned it off;
 * - `checking`: J3 Bots is still checking it;
 * - `unavailable`: it cannot run a bot, and Settings says why.
 */
export type PickerAccountState =
  | "ready"
  | "limited"
  | "signed-out"
  | "off"
  | "checking"
  | "unavailable";

/** An account in the picker's rail. */
export interface PickerAccount {
  readonly providerId: ProviderStatus["id"];
  /** As the operator named it, such as "Claude (work)". */
  readonly name: string;
  /** The harness that runs it, for its mark: Claude Code, Codex, or another. */
  readonly harness: ProviderStatus["harness"];
  readonly state: PickerAccountState;
  /** Whether a bot can be put on it now: it runs, or will once its limit resets. */
  readonly choosable: boolean;
}

/** A model in the picker. */
export interface PickerModel {
  readonly choice: ModelChoice;
  readonly name: string;
  /** The account's name, which a starred or searched list shows beside the model's. */
  readonly accountName: string;
  /** Its levels of effort, lowest first; empty for a model that takes none. */
  readonly efforts: ReadonlyArray<EffortChoice>;
  readonly fast: boolean;
  readonly starred: boolean;
  /** Whether a bot can be put on it now (`PickerAccount.choosable`). */
  readonly choosable: boolean;
}

export interface ModelPicker {
  /** The rail: every account the engine reports, in its order. */
  readonly accounts: ReadonlyArray<PickerAccount>;
  /** The starred models the engine offers, in the order they were starred. */
  readonly starred: ReadonlyArray<PickerModel>;
  /** Every model of every account, by account, in the engine's order. */
  readonly models: ReadonlyArray<PickerModel>;
}

const stateOf = (provider: ProviderStatus): PickerAccountState => {
  const { status } = provider;
  switch (status._tag) {
    case "ready":
      return "ready";
    case "limited":
      return "limited";
    case "sign-in-required":
      return "signed-out";
    case "unavailable":
      if (provider.setup?.enabled === false || status.reason === "disabled") return "off";
      return status.checking ? "checking" : "unavailable";
  }
};

/** What the operator calls an account: the name they gave it, else its AI's. */
const accountName = (provider: ProviderStatus): string =>
  provider.setup !== undefined || provider.harness === "other"
    ? provider.name
    : aiAccountNames[provider.harness].name;

/**
 * The picker over the engine's status `engine`, with the operator's stars
 * `favorites`. A star on a model the engine does not offer now is kept, and
 * not listed.
 */
export function modelPicker(
  engine: EngineStatus | null,
  favorites: ReadonlyArray<ModelChoice>,
): ModelPicker {
  const providers = engine?.providers ?? [];
  const accounts = providers.map((provider): PickerAccount => {
    const state = stateOf(provider);
    return {
      providerId: provider.id,
      name: accountName(provider),
      harness: provider.harness,
      state,
      choosable: state === "ready" || state === "limited",
    };
  });
  const models = providers.flatMap((provider, index) => {
    const account = accounts[index];
    return provider.models.map(
      (model): PickerModel => ({
        choice: { providerId: provider.id, modelId: model.id },
        name: model.name,
        accountName: account?.name ?? provider.name,
        efforts: model.efforts ?? [],
        fast: model.fast === true,
        starred: favorites.some(
          (star) => star.providerId === provider.id && star.modelId === model.id,
        ),
        choosable: account?.choosable === true,
      }),
    );
  });
  const starred = favorites.flatMap((star) => {
    const found = models.find((model) => sameModel(model.choice, star));
    return found === undefined ? [] : [found];
  });
  return { accounts, starred, models };
}

/** The model `choice` in `picker`; undefined for one the engine does not offer now. */
export const pickedModel = (picker: ModelPicker, choice: ModelChoice): PickerModel | undefined =>
  picker.models.find((model) => sameModel(model.choice, choice));

/** Text as search compares it: case and accents set aside. */
const folded = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLocaleLowerCase();

/**
 * The models whose name, id or account's name holds every word of `query`,
 * case and accents set aside, in the picker's order; every model for a
 * query with no words.
 */
export function searchModels(picker: ModelPicker, query: string): ReadonlyArray<PickerModel> {
  const words = folded(query).split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return picker.models;
  return picker.models.filter((model) => {
    const text = folded(`${model.name} ${model.choice.modelId} ${model.accountName}`);
    return words.every((word) => text.includes(word));
  });
}

/**
 * The stars to show: those of a save under way, so a star shows the moment
 * the operator taps it, else the server's. Null from a server that keeps no
 * stars (`Settings.favoriteModels` absent), where the picker offers none.
 */
export function shownFavorites(
  saved: ReadonlyArray<ModelChoice> | undefined,
  save: SettingsSave<FavoriteChanges>,
): ReadonlyArray<ModelChoice> | null {
  if (saved === undefined) return null;
  return save._tag === "saving" ? save.changes.favoriteModels : saved;
}

/** `favorites` with `choice` starred, last, or no longer starred. */
export const withStar = (
  favorites: ReadonlyArray<ModelChoice>,
  choice: ModelChoice,
  starred: boolean,
): ReadonlyArray<ModelChoice> => {
  const without = favorites.filter((star) => !sameModel(star, choice));
  return starred ? [...without, choice] : without;
};

/**
 * `setting` once the operator picks `model`: its effort where the new model
 * takes it, else the default, and its fast mode where the new model has one,
 * else off, so the picker never holds what the model lacks. While the engine
 * does not list the model, both stay as they were.
 */
export function withModel(
  engine: EngineStatus | null,
  setting: ModelSetting,
  model: ModelChoice,
): ModelSetting {
  const levels = engine === null ? null : modelEfforts(engine, model);
  const fast = engine === null ? null : modelOffersFast(engine, model);
  return {
    model,
    effort:
      setting.effort === null ||
      levels === null ||
      levels.some((choice) => choice.id === setting.effort)
        ? setting.effort
        : null,
    fast: setting.fast && fast !== false,
  };
}

/**
 * Where the account of a bot's model stands, for the bot's conversation and
 * its settings: `gone` once the operator removed it, `off` while they turned
 * it off, else `ok`. Only a server that lets the operator set accounts up
 * (`ProviderStatus.setup`) can have removed one, and only a running engine
 * lists every account it has, so anything else is `ok`.
 */
export function botAccountState(
  engine: EngineStatus | null,
  model: ModelChoice,
): "ok" | "gone" | "off" {
  if (engine === null || engine.state._tag !== "ready") return "ok";
  if (!engine.providers.some((provider) => provider.setup !== undefined)) return "ok";
  const provider = engine.providers.find((candidate) => candidate.id === model.providerId);
  if (provider === undefined) return "gone";
  return provider.setup?.enabled === false ? "off" : "ok";
}
