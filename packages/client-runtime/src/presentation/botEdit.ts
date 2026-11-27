// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotChanges } from "../stores/Details.ts";
import {
  type Avatar,
  type AvatarChoice,
  type Bot,
  type EffortChoice,
  type EffortLevel,
  type EngineStatus,
  type ModelChoice,
  modelEfforts,
  type PermissionMode,
  Profile,
  type ProfileChanges,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

/** What the operator changed in the form and has not saved: null for a field they left alone. */
export interface BotEdits {
  readonly name: string | null;
  readonly title: string | null;
  readonly job: string | null;
  readonly avatar: AvatarChoice | null;
  readonly model: ModelChoice | null;
  /** The effort the operator picked: a level, or null for the default. */
  readonly effort: { readonly level: EffortLevel | null } | null;
  readonly permissionMode: PermissionMode | null;
  readonly hidden: boolean | null;
}

export const noBotEdits: BotEdits = {
  name: null,
  title: null,
  job: null,
  avatar: null,
  model: null,
  effort: null,
  permissionMode: null,
  hidden: null,
};

export type ProfileField = "name" | "title" | "job";

/** What saving the form would send. */
export type BotPatch =
  | { readonly _tag: "unchanged" }
  /** Edits the server would refuse: an empty name, or a field over its length. */
  | { readonly _tag: "invalid"; readonly fields: ReadonlySet<ProfileField> }
  | { readonly _tag: "changes"; readonly changes: BotChanges };

export const sameModel = (a: ModelChoice, b: ModelChoice) =>
  a.providerId === b.providerId && a.modelId === b.modelId;

const sameAvatar = (a: Avatar, b: Avatar) => a.shape === b.shape && a.color === b.color;

const decoders = {
  name: Schema.decodeUnknownOption(Profile.fields.name),
  title: Schema.decodeUnknownOption(Profile.fields.title),
  job: Schema.decodeUnknownOption(Profile.fields.job),
};

/**
 * `level` as `model` runs it: null, the default, for a level the engine does
 * not report for the model, once it lists the model. While it does not, the
 * model's levels are not known, and `level` stands.
 */
const effortRun = (
  engine: EngineStatus | null,
  model: ModelChoice,
  level: EffortLevel | null,
): EffortLevel | null => {
  const levels = engine === null ? null : modelEfforts(engine, model);
  return level === null || levels === null || levels.some((choice) => choice.id === level)
    ? level
    : null;
};

/**
 * The fields the operator changed from `bot`, and only those, so a save never
 * writes back a value another device changed meanwhile. Text is trimmed; an
 * edit back to the saved value sends nothing. Whether the bot is hidden is
 * sent whenever the operator moved the switch, also when a bot set the same
 * meanwhile: the server records it as their choice, which no bot changes
 * (decision 0050). The effort is sent as the model the form holds runs it
 * (`effortRun`), when the operator picked one or another model.
 */
export function botPatch(bot: Bot, edits: BotEdits, engine: EngineStatus | null): BotPatch {
  const profile: Types.Mutable<ProfileChanges> = {};
  const invalid = new Set<ProfileField>();
  for (const field of ["name", "title", "job"] as const) {
    const edit = edits[field];
    if (edit === null) continue;
    const trimmed = edit.trim();
    if (trimmed === bot.profile[field]) continue;
    const decoded = decoders[field](trimmed);
    if (Option.isNone(decoded)) invalid.add(field);
    else profile[field] = decoded.value;
  }
  if (invalid.size > 0) return { _tag: "invalid", fields: invalid };
  if (edits.avatar !== null && !sameAvatar(edits.avatar, bot.profile.avatar)) {
    profile.avatar = edits.avatar;
  }
  const changes: Types.Mutable<BotChanges> = {};
  if (Object.keys(profile).length > 0) changes.profile = profile;
  const otherModel =
    edits.model !== null && !sameModel(edits.model, bot.model) ? edits.model : null;
  if (otherModel !== null) changes.model = otherModel;
  if (edits.effort !== null || otherModel !== null) {
    const level = effortRun(
      engine,
      otherModel ?? bot.model,
      edits.effort === null ? bot.effort : edits.effort.level,
    );
    if (level !== bot.effort) changes.effort = level;
  }
  if (edits.permissionMode !== null && edits.permissionMode !== bot.permissionMode) {
    changes.permissionMode = edits.permissionMode;
  }
  if (edits.hidden !== null) changes.hidden = edits.hidden;
  return Object.keys(changes).length === 0 ? { _tag: "unchanged" } : { _tag: "changes", changes };
}

/**
 * The edits once the operator types `value` into a profile field that showed
 * `from` when they started editing it. Typing back exactly what it started
 * from drops the edit, so the field follows the bot again and a save never
 * sends a value another device changed meanwhile. Anything else stays as
 * typed, spaces included.
 */
export const withProfileEdit = (
  edits: BotEdits,
  field: ProfileField,
  value: string,
  from: string,
): BotEdits => ({ ...edits, [field]: value === from ? null : value });

/**
 * The edits once the operator moves the hidden switch to `hidden` while the
 * bot is `from`, as the server has it: moving it back to that drops the edit.
 */
export const withHiddenEdit = (edits: BotEdits, hidden: boolean, from: boolean): BotEdits => ({
  ...edits,
  hidden: hidden === from ? null : hidden,
});

/**
 * The edits after a save of `changes` failed: a field the form holds no edit
 * for takes the value the save sent, so the operator's work is never lost,
 * even in a form opened after the save started.
 */
export function editsAfterFailedBotSave(edits: BotEdits, changes: BotChanges): BotEdits {
  return {
    name: edits.name ?? changes.profile?.name ?? null,
    title: edits.title ?? changes.profile?.title ?? null,
    job: edits.job ?? changes.profile?.job ?? null,
    avatar: edits.avatar ?? changes.profile?.avatar ?? null,
    model: edits.model ?? changes.model ?? null,
    effort: edits.effort ?? (changes.effort === undefined ? null : { level: changes.effort }),
    permissionMode: edits.permissionMode ?? changes.permissionMode ?? null,
    hidden: edits.hidden ?? changes.hidden ?? null,
  };
}

interface ModelOption {
  readonly choice: ModelChoice;
  readonly name: string;
}

interface ModelGroup {
  readonly providerName: string;
  readonly models: ReadonlyArray<ModelOption>;
}

export interface ModelChoices {
  /** By provider, in the engine's order. */
  readonly groups: ReadonlyArray<ModelGroup>;
  /**
   * The models the form holds that the engine does not offer now: the bot's
   * own, then the one the operator picked. The picker still lists them, so it
   * never shows a model other than the one Save would send.
   */
  readonly unoffered: ReadonlyArray<ModelChoice>;
  /** The operator picked a model the engine has stopped offering. Save waits for another pick. */
  readonly pickUnavailable: boolean;
  /** A provider is left out because it cannot run a bot now. */
  readonly someNotReady: boolean;
}

/**
 * The models a bot can move to: those of every provider that is ready, and
 * those of the provider it runs on now, whatever its state, so the form
 * always shows where the bot is. `picked` is the operator's unsaved pick.
 * Until the engine reports its models, no pick counts as unavailable.
 */
export function modelChoices(
  engine: EngineStatus | null,
  current: ModelChoice,
  picked: ModelChoice | null,
): ModelChoices {
  const providers = engine?.providers ?? [];
  const listed = providers.filter(
    (provider) => provider.status._tag === "ready" || provider.id === current.providerId,
  );
  const groups = listed
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      providerName: provider.name,
      models: provider.models.map((model) => ({
        choice: { providerId: provider.id, modelId: model.id },
        name: model.name,
      })),
    }));
  const offered = (choice: ModelChoice) =>
    groups.some((group) => group.models.some((model) => sameModel(model.choice, choice)));
  const otherPick = picked !== null && !sameModel(picked, current) ? picked : null;
  const unoffered = [current, ...(otherPick === null ? [] : [otherPick])].filter(
    (choice) => !offered(choice),
  );
  return {
    groups,
    unoffered,
    pickUnavailable: engine !== null && otherPick !== null && !offered(otherPick),
    someNotReady: listed.length < providers.length,
  };
}

/** The effort the form shows, and what the operator can pick for the model it holds. */
export interface EffortChoices {
  /**
   * The levels the operator can pick besides the default: the model's, lowest
   * first. While the engine does not list the model, only the level the form
   * holds, if any, so the picker never shows other than what Save sends.
   * Empty when there is nothing to pick.
   */
  readonly levels: ReadonlyArray<EffortChoice>;
  /** The level the form shows, or null for the default. */
  readonly shown: EffortLevel | null;
  /**
   * The level the bot has, or the operator picked, that the model the form
   * holds does not take: the bot runs at the default instead, which the form
   * says, with the model's name. Null when there is none.
   */
  readonly fallback: { readonly level: EffortChoice; readonly modelName: string } | null;
}

/** A level with the engine's name for it from any model that takes it, else its id. */
const choiceOf = (engine: EngineStatus | null, level: EffortLevel): EffortChoice =>
  (engine?.providers ?? [])
    .flatMap((provider) => provider.models)
    .flatMap((model) => model.efforts)
    .find((choice) => choice.id === level) ?? { id: level, name: level };

/**
 * The effort for `model`, as a form shows it: `level` is the operator's pick,
 * else the bot's own. A level the model does not take shows as the default,
 * with why (`fallback`).
 */
export function effortChoices(
  engine: EngineStatus | null,
  model: ModelChoice,
  level: EffortLevel | null,
): EffortChoices {
  const levels = engine === null ? null : modelEfforts(engine, model);
  if (levels === null) {
    return {
      levels: level === null ? [] : [choiceOf(engine, level)],
      shown: level,
      fallback: null,
    };
  }
  const shown = effortRun(engine, model, level);
  const modelName = engine?.providers
    .find((provider) => provider.id === model.providerId)
    ?.models.find((candidate) => candidate.id === model.modelId)?.name;
  return {
    levels,
    shown,
    fallback:
      level !== null && shown === null && modelName !== undefined
        ? { level: choiceOf(engine, level), modelName }
        : null,
  };
}

/** `bot` as it will be once `changes` are saved, to show a save under way. */
export const withChanges = (bot: Bot, changes: BotChanges): Bot => ({
  ...bot,
  profile: { ...bot.profile, ...changes.profile },
  model: changes.model ?? bot.model,
  effort: changes.effort === undefined ? bot.effort : changes.effort,
  permissionMode: changes.permissionMode ?? bot.permissionMode,
  hidden: changes.hidden ?? bot.hidden,
});
