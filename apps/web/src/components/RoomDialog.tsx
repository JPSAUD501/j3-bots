// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { IntentFailure, RoomChanges, RoomDraft } from "@j3-bots/client-runtime";
import type { Bot, BotId, Room } from "@j3-bots/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import {
  blankRoomForm,
  hostOf,
  ROOM_MEMBERS,
  ROOM_NAME_MAX,
  roomChanges,
  roomDraft,
  roomFormOf,
  type RoomFormProblem,
  type RoomFormValues,
  sameRoomForm,
  withMember,
} from "../presentation/roomForm";
import { AvatarShape } from "./BotAvatar";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";

/**
 * What the form is for: a new room, changing one, or giving an archived one
 * what it needs back. `gone` when the room was deleted while the form was
 * open: the form stays, says so, and saves nothing.
 */
export type RoomFormMode =
  | { readonly _tag: "create" }
  | { readonly _tag: "edit" | "unarchive"; readonly room: Room; readonly gone: boolean };

/** What the form sends: a new room, or changes to the one it edits. */
export type RoomSubmission =
  | { readonly _tag: "create"; readonly draft: RoomDraft }
  | { readonly _tag: "update"; readonly changes: RoomChanges };

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
  /** Where the form starts, for the gallery; the room as it is, or empty, otherwise. */
  readonly initial?: RoomFormValues;
  /** A failure to show from the start, for the gallery. */
  readonly initialFailure?: IntentFailure;
}

const fieldClass =
  "w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent read-only:text-muted-foreground disabled:text-muted-foreground aria-invalid:border-blocked";

/**
 * A room's name, its bots, which of them hosts, and how many replies in a
 * row bots may trade before the room waits for the operator. The host
 * follows the bots picked: the one the operator chose while it stays in,
 * else the primary bot, else the first picked. What is missing is said once
 * the operator tries to send; a refusal from the server is said in the footer,
 * or beside the bots when they are the reason, and keeps what was typed. Save
 * sends only what the operator changed from what the form opened with, and
 * with nothing changed it closes without asking the server. A bot picked and
 * deleted meanwhile leaves the selection, which says so; a room deleted
 * meanwhile keeps the form open, saying so, and saves nothing.
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
    hopLimit: useId(),
    hopLimitHint: useId(),
    hopLimitError: useId(),
  };
  const room = mode._tag === "create" ? null : mode.room;
  const gone = mode._tag !== "create" && mode.gone;
  // Where the form started: the room as it was when the form opened, or nothing.
  const [start] = useState(() => initial ?? (room === null ? blankRoomForm : roomFormOf(room)));
  const [values, setValues] = useState(start);
  // Bots picked and then deleted elsewhere, by name, which leave the selection and are named under it.
  const [dropped, setDropped] = useState<ReadonlyArray<string>>([]);
  const [botsSeen, setBotsSeen] = useState(bots);
  if (botsSeen !== bots) {
    setBotsSeen(bots);
    const present = new Set<BotId>(bots.map((bot) => bot.id));
    const deleted = values.members.filter((id) => !present.has(id));
    if (deleted.length > 0) {
      setValues({ ...values, members: values.members.filter((id) => present.has(id)) });
      const names = new Map(botsSeen.map((bot) => [bot.id, bot.profile.name]));
      setDropped([...dropped, ...deleted.flatMap((id) => names.get(id) ?? [])]);
    }
  }
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<IntentFailure | null>(initialFailure ?? null);
  // What is missing shows once the operator tried to send, and follows the form from then on.
  const [tried, setTried] = useState(false);

  const primaryId = bots.find((bot) => bot.primary)?.id ?? null;
  const hostId = hostOf(values, primaryId);
  const draft = room === null ? roomDraft(values, primaryId) : null;
  const changes = room === null ? null : roomChanges(start, values, primaryId, defaultHopLimit);
  // What goes to the server, once nothing is missing.
  const submission: RoomSubmission | null =
    draft?._tag === "ready"
      ? { _tag: "create", draft: draft.value }
      : changes?._tag === "ready"
        ? {
            _tag: "update",
            changes:
              mode._tag === "unarchive" ? { ...changes.value, archived: false } : changes.value,
          }
        : null;
  const missing =
    draft?._tag === "invalid"
      ? draft.problems
      : changes?._tag === "invalid"
        ? changes.problems
        : null;
  const problems: ReadonlySet<RoomFormProblem> = tried && missing !== null ? missing : new Set();
  const full = values.members.length >= ROOM_MEMBERS.max;
  const unsaved = !sameRoomForm(start, values, primaryId, defaultHopLimit);
  useEffect(() => {
    if (!unsaved || onUnsavedChange === undefined) return;
    onUnsavedChange(true);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const change = (next: RoomFormValues) => {
    if (busy) return;
    setValues(next);
    setFailure(null);
  };
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const members = values.members.flatMap((id) => {
    const bot = byId.get(id);
    return bot ? [bot] : [];
  });
  const choices = bots.toSorted((a, b) => a.profile.name.localeCompare(b.profile.name));

  const name = room?.name ?? "";
  const refusedMembers =
    failure?._tag === "refused" &&
    failure.error._tag === "Invalid" &&
    failure.error.reason === "room-members";
  const failureText = gone
    ? t("roomForm.gone", { name })
    : failure === null || refusedMembers
      ? null
      : failure._tag === "refused" && failure.error._tag === "Conflict"
        ? t("roomForm.archived", { name })
        : failure._tag === "refused" && failure.error._tag === "NotFound" && room !== null
          ? t("roomForm.gone", { name })
          : room === null
            ? t("roomForm.createFailed")
            : t("roomForm.failed");

  const submit = () => {
    if (busy || !connected || gone) return;
    setTried(true);
    if (submission === null) return;
    // Nothing changed: there is nothing to ask the server.
    if (submission._tag === "update" && Object.keys(submission.changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    void onSubmit(submission).then((failed) => {
      setBusy(false);
      setFailure(failed);
    });
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
  const membersInvalid = problems.has("members") || refusedMembers;

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
        <h2 id={titleId} className="truncate text-sm font-medium">
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
            onChange={(event) => change({ ...values, name: event.currentTarget.value })}
            aria-invalid={problems.has("name") || undefined}
            aria-describedby={problems.has("name") ? ids.nameError : undefined}
            className={cn(fieldClass, "h-9 pointer-coarse:h-11")}
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
                      if (!unavailable) change(withMember(values, bot.id, !picked));
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
                    <AvatarShape avatar={bot.profile.avatar} size={20} />
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
            {refusedMembers
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
              aria-describedby={ids.hostHint}
              onChange={(event) => {
                const picked = members.find((bot) => bot.id === event.currentTarget.value);
                if (picked) change({ ...values, hostPick: picked.id });
              }}
              className={cn(fieldClass, "h-9 pointer-coarse:h-11")}
            >
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.profile.name}
                </option>
              ))}
            </select>
            <p id={ids.hostHint} className="text-2xs text-muted-foreground">
              {t("roomForm.host.hint")}
            </p>
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
            onChange={(event) => change({ ...values, hopLimit: event.currentTarget.value })}
            aria-invalid={problems.has("hop-limit") || undefined}
            aria-describedby={
              problems.has("hop-limit")
                ? `${ids.hopLimitHint} ${ids.hopLimitError}`
                : ids.hopLimitHint
            }
            className={cn(fieldClass, "h-9 w-24 pointer-coarse:h-11")}
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
          <Button type="submit" variant="primary" aria-disabled={busy || !connected || gone}>
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-labelledby={titleId}
          className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 tablet:inset-x-4 tablet:top-12 tablet:bottom-12 tablet:mx-auto tablet:max-w-lg tablet:rounded-lg tablet:border tablet:border-border tablet:shadow-xl"
        >
          {/* Mounted afresh with each opening, so it starts from the room as saved. */}
          {held !== null && (
            <RoomForm
              key={held.opening}
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
