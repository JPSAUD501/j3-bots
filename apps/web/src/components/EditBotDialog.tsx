// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { BotChanges, Save } from "@j3-bots/client-runtime";
import { type Bot, type EngineStatus, PermissionMode, PROFILE_LIMITS } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import {
  type BotEdits,
  botPatch,
  editsAfterFailedBotSave,
  modelChoices,
  noBotEdits,
  type ProfileField,
  sameModel,
  withChanges,
} from "../presentation/botEdit";
import { shownSaveProblem } from "../presentation/saves";
import { permissionText } from "./DetailsPanel";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";

/** The props of the form, whatever frames it: the dialog in the app, a pane in the gallery. */
export interface EditBotFormProps {
  /** The bot as the server has it now. Fields the operator left alone follow it. */
  readonly bot: Bot;
  /** Where the models come from; null until the server has reported it. */
  readonly engine: EngineStatus | null;
  /** The bot's latest update, under way or failed, which may predate this form. */
  readonly save: Save<BotChanges> | undefined;
  /** Saving takes a connection to the server. */
  readonly connected: boolean;
  readonly onSave: (changes: BotChanges) => void;
  readonly onClose: () => void;
  /** Told when the form starts and stops holding edits that are not saved. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  /** The id of the form's heading, which names the dialog. */
  readonly titleId: string;
}

const fieldClass =
  "w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent read-only:text-muted-foreground aria-invalid:border-blocked";

const modes = PermissionMode.literals;
const isMode = Schema.is(PermissionMode);

/** A model choice as a `<select>` value. */
const keyOf = (choice: Bot["model"]) => JSON.stringify([choice.providerId, choice.modelId]);

/**
 * Everything the operator changes about a bot itself: its name, title and
 * job, the model it runs on and how much it may do without asking. Save sends
 * only what changed. While a save is under way the form shows what it sends
 * and takes no edit; a save that fails leaves the edits in place and says
 * why, beside the field when one field is the reason.
 */
export function EditBotForm({
  bot,
  engine,
  save,
  connected,
  onSave,
  onClose,
  onUnsavedChange,
  titleId,
}: EditBotFormProps) {
  const { t } = useI18n();
  const ids = {
    name: useId(),
    title: useId(),
    job: useId(),
    jobHint: useId(),
    model: useId(),
    mode: useId(),
  };
  const errorIds = { name: useId(), title: useId(), job: useId(), model: useId() };
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
  const edit = (change: Partial<BotEdits>) => {
    setEdits((current) => ({ ...current, ...change }));
    setFailureShown(false);
  };

  const saving = save?._tag === "saving";
  const shown = saving ? withChanges(bot, save.changes) : bot;
  const name = edits.name ?? shown.profile.name;
  const title = edits.title ?? shown.profile.title;
  const job = edits.job ?? shown.profile.job;
  const model = edits.model ?? shown.model;
  const mode = edits.permissionMode ?? shown.permissionMode;
  const patch = botPatch(bot, edits);
  const invalid = patch._tag === "invalid" ? patch.fields : new Set<ProfileField>();
  const problem = shownSaveProblem(save, !failureShown);
  const choices = modelChoices(engine, bot.model, edits.model);
  const modelMessage =
    problem === "model" || choices.pickUnavailable ? t("editBot.model.unavailable") : null;
  const settingsChange = !sameModel(model, bot.model) || mode !== bot.permissionMode;
  const canSave = patch._tag === "changes" && !choices.pickUnavailable && !saving && connected;

  const unsaved = patch._tag !== "unchanged";
  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const fieldError = (field: ProfileField) =>
    invalid.has(field) ? (
      <p id={errorIds[field]} className="text-xs text-blocked">
        {field === "name" && name.trim() === ""
          ? t("editBot.name.required")
          : t("editBot.tooLong", { max: PROFILE_LIMITS[field] })}
      </p>
    ) : null;
  const errorProps = (field: ProfileField) =>
    invalid.has(field) ? { "aria-invalid": true, "aria-describedby": errorIds[field] } : {};

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (patch._tag !== "changes" || !canSave) return;
        onSave(patch.changes);
      }}
    >
      <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="truncate text-sm font-medium">
          {t("editBot.title", { name: bot.profile.name })}
        </h2>
        <Button
          variant="ghost-muted"
          size="icon"
          className="ms-auto"
          onClick={onClose}
          aria-label={t("editBot.close")}
        >
          <XIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.name} className="text-xs">
            {t("editBot.name")}
          </label>
          <input
            id={ids.name}
            value={name}
            maxLength={PROFILE_LIMITS.name}
            readOnly={saving}
            autoComplete="off"
            onChange={(event) => edit({ name: event.currentTarget.value })}
            className={cn(fieldClass, "h-9 pointer-coarse:h-11")}
            {...errorProps("name")}
          />
          {fieldError("name")}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.title} className="text-xs">
            {t("editBot.titleField")}
          </label>
          <input
            id={ids.title}
            value={title}
            maxLength={PROFILE_LIMITS.title}
            readOnly={saving}
            autoComplete="off"
            placeholder={t("editBot.titleField.placeholder")}
            onChange={(event) => edit({ title: event.currentTarget.value })}
            className={cn(fieldClass, "h-9 pointer-coarse:h-11")}
            {...errorProps("title")}
          />
          {fieldError("title")}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.job} className="text-xs">
            {t("editBot.job")}
          </label>
          <textarea
            id={ids.job}
            value={job}
            maxLength={PROFILE_LIMITS.job}
            readOnly={saving}
            rows={4}
            onChange={(event) => edit({ job: event.currentTarget.value })}
            aria-describedby={invalid.has("job") ? `${ids.jobHint} ${errorIds.job}` : ids.jobHint}
            aria-invalid={invalid.has("job") || undefined}
            className={cn(fieldClass, "field-sizing-content min-h-24 resize-none py-2")}
          />
          <p id={ids.jobHint} className="text-2xs text-muted-foreground">
            {t("editBot.job.hint", { name: bot.profile.name })}
          </p>
          {fieldError("job")}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.model} className="text-xs">
            {t("editBot.model")}
          </label>
          <select
            id={ids.model}
            value={keyOf(model)}
            disabled={saving}
            aria-invalid={modelMessage !== null || undefined}
            aria-describedby={modelMessage === null ? undefined : errorIds.model}
            onChange={(event) => {
              const key = event.currentTarget.value;
              const picked = [
                ...choices.unoffered,
                ...choices.groups.flatMap((group) => group.models.map((option) => option.choice)),
              ].find((choice) => keyOf(choice) === key);
              edit({ model: picked ?? bot.model });
            }}
            className={cn(fieldClass, "h-9 pointer-coarse:h-11 disabled:text-muted-foreground")}
          >
            {choices.unoffered.map((choice) => (
              <option key={keyOf(choice)} value={keyOf(choice)}>
                {engine === null
                  ? choice.modelId
                  : t("editBot.model.notOffered", { model: choice.modelId })}
              </option>
            ))}
            {choices.groups.map((group) => (
              <optgroup key={group.providerName} label={group.providerName}>
                {group.models.map((option) => (
                  <option key={keyOf(option.choice)} value={keyOf(option.choice)}>
                    {option.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* Exposed while empty, so a refusal that arrives later is announced. */}
          <p id={errorIds.model} role="alert" className="text-xs text-blocked empty:sr-only">
            {modelMessage}
          </p>
          {choices.someNotReady && (
            <p className="text-2xs text-muted-foreground">{t("editBot.model.someNotReady")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p id={ids.mode} className="text-xs">
            {t("editBot.permissionMode")}
          </p>
          <RadioGroup
            aria-labelledby={ids.mode}
            value={mode}
            onValueChange={(value: unknown) => {
              if (isMode(value)) edit({ permissionMode: value });
            }}
            readOnly={saving}
            className="flex flex-col gap-1.5"
          >
            {modes.map((option) => {
              const [label, description] = permissionText[option];
              return (
                <Radio.Root
                  key={option}
                  value={option}
                  className={cn(
                    choiceRow,
                    "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-readonly:hover:bg-transparent",
                  )}
                >
                  <ChoiceIndicator shape="round">
                    <Radio.Indicator className="size-2 rounded-pill bg-background" />
                  </ChoiceIndicator>
                  <span className="flex flex-col">
                    <span>{t(label)}</span>
                    <span className="text-xs text-muted-foreground">{t(description)}</span>
                  </span>
                </Radio.Root>
              );
            })}
          </RadioGroup>
        </div>

        {settingsChange && (
          <p className="text-xs text-muted-foreground">
            {t("editBot.nextTurn", { name: bot.profile.name })}
          </p>
        )}
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <p role="alert" className="text-xs text-blocked empty:sr-only">
          {problem === "gone"
            ? t("editBot.gone", { name: bot.profile.name })
            : problem !== null && problem !== "model"
              ? t("editBot.failed")
              : null}
        </p>
        {!connected && (
          <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t("editBot.cancel")}</Button>
          <Button type="submit" variant="primary" aria-disabled={!canSave}>
            {saving ? t("editBot.saving") : t("editBot.save")}
          </Button>
        </div>
      </footer>
    </form>
  );
}

interface EditBotDialogProps extends Omit<EditBotFormProps, "bot" | "titleId" | "onUnsavedChange"> {
  /** The bot being edited; null closes the dialog. */
  readonly bot: Bot | null;
}

/** `EditBotForm` as a dialog: the whole screen on a phone, a sheet over the app on wider ones. */
export function EditBotDialog({ bot, onClose, ...form }: EditBotDialogProps) {
  const titleId = useId();
  // A click outside does not throw away unsaved edits; Escape and the close button still close.
  const [unsaved, setUnsaved] = useState(false);
  const { held, closed } = useHeldWhileClosing(bot);
  return (
    <Dialog.Root
      open={bot !== null}
      disablePointerDismissal={unsaved}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) closed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-labelledby={titleId}
          className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 tablet:inset-x-4 tablet:top-12 tablet:bottom-12 tablet:mx-auto tablet:max-w-lg tablet:rounded-lg tablet:border tablet:border-border tablet:shadow-xl"
        >
          {/* Mounted afresh with each opening, so it starts from the bot as saved. */}
          {held !== null && (
            <EditBotForm
              key={held.opening}
              bot={held.value}
              onClose={onClose}
              onUnsavedChange={setUnsaved}
              titleId={titleId}
              {...form}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
