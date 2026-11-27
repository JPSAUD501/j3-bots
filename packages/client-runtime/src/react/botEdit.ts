// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, Bot, EngineStatus, ModelChoice, PermissionMode } from "@j3-bots/contracts";
import { useState } from "react";
import type { BotChanges, Save } from "../stores/Details.ts";
import {
  type BotEdits,
  botPatch,
  type EffortChoices,
  effortChoices,
  editsAfterFailedBotSave,
  type ModelChoices,
  modelChoices,
  noBotEdits,
  type ProfileField,
  sameModel,
  withChanges,
  withHiddenEdit,
  withProfileEdit,
} from "../presentation/botEdit.ts";
import { type SaveProblem, shownSaveProblem } from "../presentation/saves.ts";

/** Why a profile field cannot be saved as it is. */
export type ProfileFieldProblem = "required" | "too-long";

export interface BotEdit {
  /** What each field shows: the operator's edit, else what is being saved, else the bot as it is. */
  readonly name: string;
  readonly title: string;
  readonly job: string;
  readonly avatar: Avatar;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  /** Among the hidden conversations rather than in the roster's list. */
  readonly hidden: boolean;
  /** Whether a save is under way; the form then shows what it sends and takes no edit. */
  readonly saving: boolean;
  readonly fieldProblem: (field: ProfileField) => ProfileFieldProblem | null;
  /** The latest save's problem, while it shows. */
  readonly problem: SaveProblem | null;
  readonly choices: ModelChoices;
  /** The effort shown for the model the form holds, and the levels it takes. */
  readonly effort: EffortChoices;
  /** The model picked, or the one the bot runs on, is one the engine no longer offers. */
  readonly modelUnavailable: boolean;
  /** The model, its effort or the permission mode changes, which takes effect on the next turn. */
  readonly settingsChange: boolean;
  /** The provider changes, which stops a turn under way. */
  readonly providerChange: boolean;
  /** Whether the form holds edits that are not saved. */
  readonly unsaved: boolean;
  /** What Save sends, or null while it cannot. */
  readonly changes: BotChanges | null;
  readonly editText: (field: ProfileField, value: string) => void;
  readonly edit: (
    change: Partial<Pick<BotEdits, "avatar" | "model" | "effort" | "permissionMode" | "hidden">>,
  ) => void;
}

/**
 * The edit of a bot's name, title, avatar and job, its model and effort, its permission mode
 * and whether it is hidden, as a form holds it. Save sends only what changed. A save that fails leaves
 * the edits in place, and its problem shows until the operator edits again.
 * Fields the operator left alone follow the bot as the server has it.
 */
export function useBotEdit(options: {
  /** The bot as the server has it now. */
  readonly bot: Bot;
  /** Where the models come from; null until the server has reported it. */
  readonly engine: EngineStatus | null;
  /** The bot's latest update, under way or failed, which may predate this form. */
  readonly save: Save<BotChanges> | undefined;
  /** Saving takes a connection to the server. */
  readonly connected: boolean;
}): BotEdit {
  const { bot, engine, save, connected } = options;
  const [edits, setEdits] = useState<BotEdits>(() =>
    save?._tag === "failed" ? editsAfterFailedBotSave(noBotEdits, save.changes) : noBotEdits,
  );
  // A failure shows until the operator edits again.
  const [failureShown, setFailureShown] = useState(save?._tag === "failed");
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save?._tag === "failed") {
      setEdits((current) => editsAfterFailedBotSave(current, save.changes));
      setFailureShown(true);
    }
  }
  // What each text field showed when its edit started: typing it back ends the edit.
  const [startedFrom, setStartedFrom] = useState<Readonly<Record<ProfileField, string | null>>>({
    name: null,
    title: null,
    job: null,
  });

  const saving = save?._tag === "saving";
  const shown = saving ? withChanges(bot, save.changes) : bot;
  const name = edits.name ?? shown.profile.name;
  const model = edits.model ?? shown.model;
  const permissionMode = edits.permissionMode ?? shown.permissionMode;
  const patch = botPatch(bot, edits, engine);
  const problem = shownSaveProblem(save, !failureShown);
  const choices = modelChoices(engine, bot.model, edits.model);
  const effort = effortChoices(
    engine,
    model,
    edits.effort === null ? shown.effort : edits.effort.level,
  );
  const canSave = patch._tag === "changes" && !choices.pickUnavailable && !saving && connected;

  return {
    name,
    title: edits.title ?? shown.profile.title,
    job: edits.job ?? shown.profile.job,
    avatar: edits.avatar ?? shown.profile.avatar,
    model,
    permissionMode,
    hidden: edits.hidden ?? shown.hidden,
    saving,
    fieldProblem: (field) =>
      patch._tag !== "invalid" || !patch.fields.has(field)
        ? null
        : (field === "name" ? name : (edits[field] ?? "")).trim() === ""
          ? "required"
          : "too-long",
    problem,
    choices,
    effort,
    modelUnavailable: problem === "model" || choices.pickUnavailable,
    settingsChange:
      !sameModel(model, bot.model) ||
      permissionMode !== bot.permissionMode ||
      (patch._tag === "changes" && patch.changes.effort !== undefined),
    providerChange: model.providerId !== bot.model.providerId,
    unsaved: patch._tag !== "unchanged",
    changes: canSave && patch._tag === "changes" ? patch.changes : null,
    editText: (field, value) => {
      const from = startedFrom[field] ?? bot.profile[field];
      setStartedFrom((current) => ({ ...current, [field]: value === from ? null : from }));
      setEdits((current) => withProfileEdit(current, field, value, from));
      setFailureShown(false);
    },
    edit: (change) => {
      setEdits((current) => {
        const next = { ...current, ...change };
        const { hidden } = change;
        return hidden === undefined || hidden === null
          ? next
          : withHiddenEdit(next, hidden, bot.hidden);
      });
      setFailureShown(false);
    },
  };
}
