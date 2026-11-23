// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { Bot } from "@j3-bots/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useId } from "react";
import type { IntentFailure } from "@j3-bots/client-runtime";
import {
  ROOM_NAME_MAX,
  roomFormTarget,
  type RoomFormMode,
  type RoomFormValues,
} from "@j3-bots/client-runtime/presentation";
import { type RoomSubmission, useRoomForm } from "@j3-bots/client-runtime/react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { BotAvatar } from "./avatar/BotAvatar";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";
import { dialogBackdrop, screenDialog } from "./ui/dialog";
import { lineField, textField } from "./ui/field";

/** The props of the form, whatever frames it: the dialog in the app, a pane in the gallery. */
export interface RoomFormProps {
  readonly mode: RoomFormMode;
  /** Every bot the operator has, to pick members from. */
  readonly bots: ReadonlyArray<Bot>;
  /** The hop limit a room takes when it gives none; null until the settings are read. */
  readonly defaultHopLimit: number | null;
  /** Saving takes a connection to the server. */
  readonly connected: boolean;
  /** Resolves with why it failed, or null once the server has it; the dialog then closes. */
  readonly onSubmit: (submission: RoomSubmission) => Promise<IntentFailure | null>;
  readonly onClose: () => void;
  /** Told when the form starts and stops holding what the operator changed and did not send. */
  readonly onUnsavedChange?: (unsaved: boolean) => void;
  /** The id of the form's heading, which names the dialog. */
  readonly titleId: string;
  /** Where the form starts, for the gallery; the room as the server has it, or empty, otherwise. */
  readonly initial?: RoomFormValues;
  /** A failure to show from the start, for the gallery. */
  readonly initialFailure?: IntentFailure;
}

/**
 * A room's name, its bots, which of them hosts, and how many replies in a
 * row bots may trade before the room waits for the operator. The host
 * follows the bots picked: the one the operator chose while it stays in,
 * else the primary bot, else the first picked; a room the server has without
 * a host shows none until the operator picks one. What is missing is said once
 * the operator tries to send; a refusal from the server is said in the footer,
 * or beside the bots when they are the reason, and keeps what was typed. What
 * the operator left alone follows the room as the server has it, so a change
 * made elsewhere shows here; Save sends only what the form changes from the
 * room as it is, and with nothing changed it closes without asking the
 * server. A bot picked and deleted meanwhile leaves the selection, which says
 * so; a room deleted meanwhile keeps the form open, saying so, and saves
 * nothing.
 */
export function RoomForm({
  mode,
  bots,
  defaultHopLimit,
  connected,
  onSubmit,
  onClose,
  onUnsavedChange,
  titleId,
  initial,
  initialFailure,
}: RoomFormProps) {
  const { t, plural, locale } = useI18n();
  const ids = {
    name: useId(),
    nameError: useId(),
    members: useId(),
    membersHint: useId(),
    membersError: useId(),
    host: useId(),
    hostHint: useId(),
    hostError: useId(),
    hopLimit: useId(),
    hopLimitHint: useId(),
    hopLimitError: useId(),
  };
  const form = useRoomForm({
    mode,
    bots,
    defaultHopLimit,
    connected,
    locale,
    initial,
    initialFailure,
  });
  const { room, values, members, choices, hostId, full, problems, busy, dropped, unsaved } = form;
  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const name = room?.name ?? "";
  const failureText =
    form.failure === null
      ? null
      : {
          gone: t("roomForm.gone", { name }),
          archived: t("roomForm.archived", { name }),
          "create-failed": t("roomForm.createFailed"),
          failed: t("roomForm.failed"),
        }[form.failure];

  const submit = () => {
    if (form.submit(onSubmit) === "unchanged") onClose();
  };

  const title =
    mode._tag === "create"
      ? t("roomForm.newTitle")
      : mode._tag === "edit"
        ? t("roomForm.editTitle", { name })
        : t("roomForm.unarchiveTitle", { name });
  const submitText = busy
    ? mode._tag === "create"
      ? t("roomForm.creating")
      : t("roomForm.saving")
    : mode._tag === "create"
      ? t("roomForm.create")
      : mode._tag === "edit"
        ? t("roomForm.save")
        : t("roomForm.unarchive");
  const membersInvalid = problems.has("members") || form.membersRefused;

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="display-type truncate text-lg">
          {title}
        </h2>
        <Button
          variant="ghost-muted"
          size="icon"
          className="ms-auto"
          onClick={onClose}
          aria-label={t("roomForm.close")}
        >
          <XIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {mode._tag === "unarchive" && (
          <p className="text-sm text-muted-foreground">{t("roomForm.unarchiveBody", { name })}</p>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.name} className="text-xs">
            {t("roomForm.name")}
          </label>
          <input
            id={ids.name}
            value={values.name}
            maxLength={ROOM_NAME_MAX}
            readOnly={busy}
            autoComplete="off"
            onChange={(event) => form.change({ ...values, name: event.currentTarget.value })}
            aria-invalid={problems.has("name") || undefined}
            aria-describedby={problems.has("name") ? ids.nameError : undefined}
            className={cn(lineField, "disabled:text-muted-foreground")}
          />
          {problems.has("name") && (
            <p id={ids.nameError} className="text-xs text-blocked">
              {t("roomForm.name.required")}
            </p>
          )}
        </div>

        <fieldset
          className="flex flex-col gap-1.5"
          aria-describedby={
            membersInvalid ? `${ids.membersHint} ${ids.membersError}` : ids.membersHint
          }
        >
          <legend className="mb-1 text-xs">{t("roomForm.members")}</legend>
          <p id={ids.membersHint} className="-mt-1 text-2xs text-muted-foreground">
            {t("roomForm.members.hint")}
          </p>
          <ul className="flex flex-col gap-1.5">
            {choices.map((bot) => {
              const picked = values.members.includes(bot.id);
              // A seventh bot cannot be added: its row stays focusable and does nothing.
              const unavailable = busy || (full && !picked);
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={picked}
                    aria-disabled={unavailable || undefined}
                    data-checked={picked ? "" : undefined}
                    onClick={() => {
                      if (!unavailable) form.toggleMember(bot.id);
                    }}
                    className={cn(
                      choiceRow,
                      "group/option items-center hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted aria-disabled:hover:bg-transparent",
                      unavailable && !picked && "text-muted-foreground",
                    )}
                  >
                    <ChoiceIndicator shape="square">
                      {picked && <CheckIcon className="size-3" strokeWidth={3} />}
                    </ChoiceIndicator>
                    <BotAvatar
                      avatar={bot.profile.avatar}
                      seed={bot.id}
                      state="idle"
                      size={24}
                      still
                    />
                    <span className="min-w-0 truncate">{bot.profile.name}</span>
                    {bot.profile.title !== "" && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {bot.profile.title}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Exposed while empty, so a refusal that arrives later is announced. */}
          <p id={ids.membersError} role="alert" className="text-xs text-blocked empty:sr-only">
            {form.membersRefused
              ? t("roomForm.membersRefused")
              : problems.has("members")
                ? t("roomForm.members.invalid")
                : null}
          </p>
          {/* Exposed while empty, so a bot deleted later is announced. */}
          <p role="status" className="text-xs text-muted-foreground empty:sr-only">
            {dropped.length === 0
              ? null
              : plural("roomForm.dropped", dropped.length, {
                  names: new Intl.ListFormat(locale, { type: "conjunction" }).format(dropped),
                })}
          </p>
        </fieldset>

        {members.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.host} className="text-xs">
              {t("roomForm.host")}
            </label>
            <select
              id={ids.host}
              value={hostId ?? ""}
              disabled={busy}
              aria-invalid={problems.has("host") || undefined}
              aria-describedby={
                problems.has("host") ? `${ids.hostHint} ${ids.hostError}` : ids.hostHint
              }
              onChange={(event) => {
                const picked = members.find((bot) => bot.id === event.currentTarget.value);
                if (picked) form.pickHost(picked.id);
              }}
              className={cn(lineField, "disabled:text-muted-foreground")}
            >
              {/* A room the server has without a host shows none until the operator picks one. */}
              {hostId === null && (
                <option value="" disabled>
                  {t("roomForm.host.pick")}
                </option>
              )}
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.profile.name}
                </option>
              ))}
            </select>
            <p id={ids.hostHint} className="text-2xs text-muted-foreground">
              {t("roomForm.host.hint")}
            </p>
            {problems.has("host") && (
              <p id={ids.hostError} className="text-xs text-blocked">
                {t("roomForm.host.required")}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.hopLimit} className="text-xs">
            {t("roomForm.hopLimit")}
          </label>
          <input
            id={ids.hopLimit}
            type="text"
            inputMode="numeric"
            value={values.hopLimit}
            readOnly={busy}
            autoComplete="off"
            placeholder={defaultHopLimit === null ? undefined : String(defaultHopLimit)}
            onChange={(event) => form.change({ ...values, hopLimit: event.currentTarget.value })}
            aria-invalid={problems.has("hop-limit") || undefined}
            aria-describedby={
              problems.has("hop-limit")
                ? `${ids.hopLimitHint} ${ids.hopLimitError}`
                : ids.hopLimitHint
            }
            className={cn(textField, "h-9 w-24 pointer-coarse:h-11 disabled:text-muted-foreground")}
          />
          <p id={ids.hopLimitHint} className="text-2xs text-muted-foreground">
            {t("roomForm.hopLimit.hint")}
            {defaultHopLimit !== null &&
              ` ${t("roomForm.hopLimit.default", { count: defaultHopLimit })}`}
          </p>
          {problems.has("hop-limit") && (
            <p id={ids.hopLimitError} className="text-xs text-blocked">
              {t("roomForm.hopLimit.invalid")}
            </p>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <p role="alert" className="text-xs text-blocked empty:sr-only">
          {failureText}
        </p>
        {!connected && (
          <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t("roomForm.cancel")}</Button>
          <Button type="submit" variant="primary" aria-disabled={!form.canSubmit}>
            {submitText}
          </Button>
        </div>
      </footer>
    </form>
  );
}

interface RoomDialogProps extends Omit<RoomFormProps, "mode" | "titleId" | "onUnsavedChange"> {
  /**
   * What the form is for; null closes the dialog. It must keep its identity
   * between renders while it stays the same, as `useHeldWhileClosing` asks.
   */
  readonly mode: RoomFormMode | null;
  /**
   * Whether the form holds what the operator changed and did not send, as it
   * reports through `onUnsavedChange`. Held by the owner, which keeps such a
   * form open.
   */
  readonly unsaved: boolean;
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

/** `RoomForm` as a dialog: the whole screen on a phone, a sheet over the app on wider ones. */
export function RoomDialog({ mode, onClose, unsaved, onUnsavedChange, ...form }: RoomDialogProps) {
  const titleId = useId();
  const { held, closed } = useHeldWhileClosing(mode);
  return (
    <Dialog.Root
      open={mode !== null}
      // A click outside does not throw away what was typed; Escape and the close button still close.
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
        >
          {/* Mounted afresh with each opening and each other target, so it starts from the room as saved. */}
          {held !== null && (
            <RoomForm
              key={`${held.opening}/${roomFormTarget(held.value)}`}
              mode={held.value}
              onClose={onClose}
              onUnsavedChange={onUnsavedChange}
              titleId={titleId}
              {...form}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
