// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { type Bot, type EngineStatus, PROFILE_LIMITS } from "@j3-bots/contracts";
import { XIcon } from "lucide-react";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import type { BotChanges, Save } from "@j3-bots/client-runtime";
import type { ProfileField } from "@j3-bots/client-runtime/presentation";
import { useBotEdit } from "@j3-bots/client-runtime/react";
import { effortText } from "@j3-bots/client-runtime/wording";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { AvatarPicker } from "./avatar/AvatarPicker";
import { ModelPicker } from "./ModelPicker";
import type { ModelStars } from "./modelStars";
import { BackstageSwitch } from "./Visibility";
import { PermissionModeChoices } from "./PermissionModeChoices";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";
import { lineField, textField } from "./ui/field";

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
  /** The title field, which the dialog may open at. */
  readonly titleRef?: Ref<HTMLInputElement>;
  /** The starred models; null from a server that keeps none. */
  readonly stars: ModelStars | null;
  /** Opens with the model picker open, to choose another AI. */
  readonly openPicker?: boolean;
}

/**
 * Everything the operator changes about a bot itself: its name, title, look
 * and job, the model it runs on and the effort it puts in, how much it may do without asking, and
 * whether it is behind the scenes. Save sends only what changed. While a save is under way the form shows what it sends
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
  titleRef,
  stars,
  openPicker = false,
}: EditBotFormProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const ids = {
    name: useId(),
    title: useId(),
    job: useId(),
    jobHint: useId(),
    model: useId(),
    mode: useId(),
  };
  const errorIds = { name: useId(), title: useId(), job: useId(), model: useId() };
  const form = useBotEdit({ bot, engine, save, connected });
  const { name, title, job, saving, problem, unsaved } = form;
  const mode = form.permissionMode;
  const { effort } = form;
  const modelMessage = form.modelUnavailable ? t("editBot.model.unavailable") : null;
  const [pickerOpen, setPickerOpen] = useState(openPicker);
  const accountNotice =
    form.account === "gone"
      ? t("botAccount.gone", { name: bot.profile.name })
      : form.account === "off"
        ? t("botAccount.off", {
            account:
              engine?.providers.find((provider) => provider.id === form.model.providerId)?.name ??
              form.model.providerId,
            name: bot.profile.name,
          })
        : null;

  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const fieldError = (field: ProfileField) => {
    const fieldProblem = form.fieldProblem(field);
    return fieldProblem === null ? null : (
      <p id={errorIds[field]} className="text-xs text-blocked">
        {fieldProblem === "required"
          ? t(field === "title" ? "editBot.title.required" : "editBot.name.required")
          : t("editBot.tooLong", { max: PROFILE_LIMITS[field] })}
      </p>
    );
  };
  const errorProps = (field: ProfileField) =>
    form.fieldProblem(field) === null
      ? {}
      : { "aria-invalid": true, "aria-describedby": errorIds[field] };

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (form.changes !== null) onSave(form.changes);
      }}
    >
      <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="display-type truncate text-lg">
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
            onChange={(event) => form.editText("name", event.currentTarget.value)}
            className={lineField}
            {...errorProps("name")}
          />
          {fieldError("name")}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.title} className="text-xs">
            {t("editBot.titleField")}
          </label>
          <input
            ref={titleRef}
            id={ids.title}
            value={title}
            maxLength={PROFILE_LIMITS.title}
            readOnly={saving}
            autoComplete="off"
            placeholder={t("editBot.titleField.placeholder")}
            onChange={(event) => form.editText("title", event.currentTarget.value)}
            className={lineField}
            {...errorProps("title")}
          />
          {fieldError("title")}
        </div>

        <AvatarPicker
          value={form.avatar}
          onChange={(avatar) => form.edit({ avatar })}
          name={name}
          seed={bot.id}
          readOnly={saving}
        />

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
            onChange={(event) => form.editText("job", event.currentTarget.value)}
            aria-describedby={
              form.fieldProblem("job") === null ? ids.jobHint : `${ids.jobHint} ${errorIds.job}`
            }
            aria-invalid={form.fieldProblem("job") !== null || undefined}
            className={cn(textField, "field-sizing-content min-h-24 resize-none py-2")}
          />
          <p id={ids.jobHint} className="text-2xs text-muted-foreground">
            {t("editBot.job.hint", { name: bot.profile.name })}
          </p>
          {fieldError("job")}
        </div>

        <div className="flex flex-col gap-1">
          <p id={ids.model} className="text-xs">
            {t("editBot.model")}
          </p>
          <ModelPicker
            engine={engine}
            value={form.setting}
            onChange={form.editModel}
            offerEffort
            stars={stars}
            labelledBy={ids.model}
            disabled={saving}
            invalid={modelMessage !== null || accountNotice !== null}
            describedBy={errorIds.model}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
          {/* Exposed while empty, so a refusal that arrives later is announced. */}
          <p id={errorIds.model} role="alert" className="text-xs text-blocked empty:sr-only">
            {modelMessage ?? accountNotice}
          </p>
          {accountNotice !== null && !saving && (
            <Button size="sm" className="self-start" onClick={() => setPickerOpen(true)}>
              {t("botAccount.choose")}
            </Button>
          )}
          {effort.fallback !== null && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("editBot.effort.fallback", {
                model: effort.fallback.modelName,
                level: effortText(effort.fallback.level, i18n),
                name: bot.profile.name,
              })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p id={ids.mode} className="text-xs">
            {t("editBot.permissionMode")}
          </p>
          <PermissionModeChoices
            value={mode}
            onChange={(permissionMode) => form.edit({ permissionMode })}
            readOnly={saving}
            labelledBy={ids.mode}
          />
        </div>

        {form.settingsChange && (
          <p className="text-xs text-muted-foreground">
            {t("editBot.nextTurn", { name: bot.profile.name })}
            {form.providerChange &&
              ` ${t("editBot.providerChangeStops", { name: bot.profile.name })}`}
          </p>
        )}

        <BackstageSwitch
          checked={form.hidden}
          readOnly={saving}
          onChange={(hidden) => form.edit({ hidden })}
        />
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
          <Button type="submit" variant="primary" aria-disabled={form.changes === null}>
            {saving ? t("editBot.saving") : t("editBot.save")}
          </Button>
        </div>
      </footer>
    </form>
  );
}

interface EditBotDialogProps extends Omit<
  EditBotFormProps,
  "bot" | "titleId" | "onUnsavedChange" | "titleRef"
> {
  /** The bot being edited; null closes the dialog. */
  readonly bot: Bot | null;
  /**
   * Opens at the title field, as Give a title does, or with the model picker
   * open, as Choose another AI does; otherwise where a dialog starts.
   */
  readonly at: "title" | "model" | null;
  /**
   * Whether the form holds edits that are not saved, as it reports through
   * `onUnsavedChange`. Held by the owner, which keeps such a form open.
   */
  readonly unsaved: boolean;
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

/** `EditBotForm` as a dialog: the whole screen on a phone, a sheet over the app on wider ones. */
export function EditBotDialog({
  bot,
  at,
  onClose,
  unsaved,
  onUnsavedChange,
  ...form
}: EditBotDialogProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const { held, closed } = useHeldWhileClosing(bot);
  return (
    <Dialog.Root
      open={bot !== null}
      // A click outside does not throw away unsaved edits; Escape and the close button still close.
      disablePointerDismissal={unsaved}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) closed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-lg`}
          {...(at === "title" ? { initialFocus: titleRef } : {})}
        >
          {/* Mounted afresh with each opening, so it starts from the bot as saved. */}
          {held !== null && (
            <EditBotForm
              key={held.opening}
              bot={held.value}
              onClose={onClose}
              onUnsavedChange={onUnsavedChange}
              titleId={titleId}
              titleRef={titleRef}
              openPicker={at === "model"}
              {...form}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
