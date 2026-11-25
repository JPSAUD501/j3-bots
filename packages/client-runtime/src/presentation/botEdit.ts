// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotChanges } from "../stores/Details.ts";
import {
  type Avatar,
  type AvatarChoice,
  type Bot,
  type EngineStatus,
  type ModelChoice,
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
  readonly permissionMode: PermissionMode | null;
  readonly hidden: boolean | null;
}

export const noBotEdits: BotEdits = {
  name: null,
  title: null,
  job: null,
  avatar: null,
  model: null,
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
 * The fields the operator changed from `bot`, and only those, so a save never
 * writes back a value another device changed meanwhile. Text is trimmed; an
 * edit back to the saved value sends nothing.
 */
export function botPatch(bot: Bot, edits: BotEdits): BotPatch {
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
  if (edits.model !== null && !sameModel(edits.model, bot.model)) changes.model = edits.model;
  if (edits.permissionMode !== null && edits.permissionMode !== bot.permissionMode) {
    changes.permissionMode = edits.permissionMode;
  }
  if (edits.hidden !== null && edits.hidden !== bot.hidden) changes.hidden = edits.hidden;
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

/** `bot` as it will be once `changes` are saved, to show a save under way. */
export const withChanges = (bot: Bot, changes: BotChanges): Bot => ({
  ...bot,
  profile: { ...bot.profile, ...changes.profile },
  model: changes.model ?? bot.model,
  permissionMode: changes.permissionMode ?? bot.permissionMode,
  hidden: changes.hidden ?? bot.hidden,
});
