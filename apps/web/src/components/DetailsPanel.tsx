// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Attachment,
  Bot,
  BotFile,
  MemoryFile,
  MemoryPath,
  Room,
  Routine,
  RoutineId,
} from "@j3-bots/contracts";
import {
  CalendarClockIcon,
  ChevronLeftIcon,
  CirclePauseIcon,
  FileTextIcon,
  NotebookTextIcon,
  WebhookIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode, type Ref } from "react";
import { useBots, useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import {
  activityTime,
  fileSize,
  memoryFileName,
  permissionModeText,
  routineLines,
} from "@j3-bots/client-runtime/wording";
import { BotAvatar } from "./BotAvatar";
import { FileCard } from "./FileCard";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { Switch } from "./ui/switch";

interface PanelFrameProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
  /** Names the pane for assistive technology. */
  readonly headingId?: string | undefined;
  readonly children: ReactNode;
}

/** The details region's frame. Phones show a back button; wider layouts a close button. */
function PanelFrame({ title, onClose, headingRef, headingId, children }: PanelFrameProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon"
          className="@tablet:hidden"
          onClick={onClose}
          aria-label={t("details.back")}
        >
          <ChevronLeftIcon />
        </Button>
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="truncate px-1 text-sm font-medium outline-none"
        >
          {title}
        </h2>
        <Button
          variant="ghost-muted"
          size="icon"
          className="ms-auto hidden @tablet:inline-flex"
          onClick={onClose}
          aria-label={t("details.close")}
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function DetailsSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export interface BotDetailsIntents {
  readonly setRoutineEnabled: (routineId: RoutineId, enabled: boolean) => void;
  /** Absent until a routine has a view of its own: its row then only shows it. */
  readonly openRoutine?: (routineId: RoutineId) => void;
  readonly openAttachment: (attachment: Attachment) => void;
  readonly openMemoryFile: (path: MemoryPath) => void;
  /** Absent where the bot cannot be edited. */
  readonly editProfile?: () => void;
  readonly freshStart: () => void;
  readonly deleteBot: () => void;
}

interface BotDetailsProps {
  readonly bot: Bot;
  /** Null while they load, as for `files` and `memory`. */
  readonly routines: ReadonlyArray<Routine> | null;
  /** Files the bot delivered, newest first. */
  readonly files: ReadonlyArray<BotFile> | null;
  readonly memory: ReadonlyArray<MemoryFile> | null;
  /** The model's name as the engine reports it, or null if the engine does not offer it now. */
  readonly modelName: string | null;
  readonly intents: BotDetailsIntents;
  readonly onClose: () => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly headingId?: string;
}

/** Answers: what is this bot, and what runs without me. */
export function BotDetails({
  bot,
  routines,
  files,
  memory,
  modelName,
  intents,
  onClose,
  headingRef,
  headingId,
}: BotDetailsProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const { name, title, job, avatar } = bot.profile;
  const mode = permissionModeText(bot.permissionMode, i18n);
  const { openRoutine } = intents;
  return (
    <PanelFrame
      title={t("conversation.details")}
      onClose={onClose}
      headingRef={headingRef}
      headingId={headingId}
    >
      <section className="flex flex-col items-start gap-3 border-b border-border px-4 py-5">
        <span className="[--avatar-cutout:var(--background)]">
          <BotAvatar avatar={avatar} state={bot.state} size={72} />
        </span>
        <div className="flex flex-col">
          <span className="flex items-center gap-2 text-xl font-medium">
            {name}
            {bot.primary && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                {t("details.primary")}
              </span>
            )}
          </span>
          {title !== "" && <span className="text-sm text-muted-foreground">{title}</span>}
        </div>
        <p className="text-sm whitespace-pre-wrap">
          {job === "" ? t("details.noJob", { name }) : job}
        </p>
        {intents.editProfile && (
          <Button size="sm" onClick={intents.editProfile}>
            {t("details.editProfile", { name })}
          </Button>
        )}
      </section>

      <DetailsSection title={t("details.routines")}>
        {routines === null ? (
          <Loading />
        ) : routines.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("details.noRoutines", { name })}</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {routines.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                onToggle={(enabled) => intents.setRoutineEnabled(routine.id, enabled)}
                onOpen={openRoutine && (() => openRoutine(routine.id))}
              />
            ))}
          </ul>
        )}
      </DetailsSection>

      <DetailsSection title={t("details.files")}>
        {files === null ? (
          <Loading />
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("details.noFiles", { name })}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {files.map(({ attachment }) => (
              <FileCard
                key={attachment.id}
                attachment={attachment}
                onOpen={() => intents.openAttachment(attachment)}
                className="w-full"
              />
            ))}
          </div>
        )}
      </DetailsSection>

      <DetailsSection title={t("details.memory")}>
        {memory === null ? (
          <Loading />
        ) : (
          <MemoryList
            files={memory}
            onOpen={intents.openMemoryFile}
            empty={t("details.noMemory", { name })}
          />
        )}
      </DetailsSection>

      <DetailsSection title={t("details.model")}>
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-2xs text-muted-foreground">{t("details.runsOn")}</dt>
            <dd>{modelName ?? t("details.modelUnavailable")}</dd>
          </div>
          <div>
            <dt className="text-2xs text-muted-foreground">{t("details.permissionMode")}</dt>
            <dd>{mode.name}</dd>
            <dd className="text-xs text-muted-foreground">{mode.description}</dd>
          </div>
        </dl>
      </DetailsSection>

      <DetailsSection title={t("details.workingContext")}>
        <div className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-foreground">
            {t("details.freshStartHint", { name })} {t("details.freshStartStops", { name })}
          </p>
          <Confirm
            trigger={<Button size="sm" />}
            title={t("details.freshStart.title", { name })}
            body={t("details.freshStart.body", { name })}
            cancel={t("details.freshStart.cancel")}
            confirm={t("details.freshStart")}
            onConfirm={intents.freshStart}
          >
            {t("details.freshStart")}
          </Confirm>
        </div>
      </DetailsSection>

      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <section className="px-4 py-4">
        <DeleteBot name={name} onDelete={intents.deleteBot} />
      </section>
    </PanelFrame>
  );
}

function Loading() {
  const { t } = useI18n();
  return <p className="text-xs text-muted-foreground">{t("details.loading")}</p>;
}

/**
 * Deleting a bot asks first, naming what goes and what stays; the intent is
 * emitted only once the operator confirms. Cancel is where focus starts.
 */
function DeleteBot({ name, onDelete }: { name: string; onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <Confirm
      trigger={<Button size="sm" variant="destructive-outline" />}
      title={t("details.delete.title", { name })}
      body={t("details.delete.body", { name })}
      cancel={t("details.delete.cancel", { name })}
      confirm={t("details.delete", { name })}
      onConfirm={onDelete}
    >
      {t("details.delete", { name })}
    </Confirm>
  );
}

/** A routine: name, schedule in words, next run, last result, and a switch to pause it. */
function RoutineRow({
  routine,
  onToggle,
  onOpen,
}: {
  routine: Routine;
  onToggle: (enabled: boolean) => void;
  onOpen: (() => void) | undefined;
}) {
  const ctx = usePresentation();
  const { pluralParts } = ctx.i18n;
  const lines = routineLines(routine, ctx);
  const Icon = !routine.enabled
    ? CirclePauseIcon
    : routine.trigger._tag === "webhook"
      ? WebhookIcon
      : CalendarClockIcon;
  const summaryClass = "flex min-w-0 flex-1 flex-col text-start";
  const summary = (
    <>
      <span className="truncate text-sm">{routine.name}</span>
      <span className={cn("text-xs text-muted-foreground", lines.expression && "font-mono")}>
        {lines.schedule}
      </span>
      {lines.status && <span className="text-2xs text-muted-foreground">{lines.status}</span>}
      {lines.lastRun && (
        // Only what went wrong is drawn in the blocked color; the run count stays quiet.
        <span className="text-2xs text-muted-foreground">
          {pluralParts<"routine.lastRunWithCount", ReactElement>(
            "routine.lastRunWithCount",
            routine.runCount,
            {
              lastRun: (
                <span key="lastRun" className={cn(lines.lastRun.failed && "text-blocked")}>
                  {lines.lastRun.text}
                </span>
              ),
            },
          )}
        </span>
      )}
    </>
  );
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          routine.enabled ? "text-success" : "text-muted-foreground",
        )}
      />
      {onOpen ? (
        <button type="button" onClick={onOpen} className={summaryClass}>
          {summary}
        </button>
      ) : (
        <div className={summaryClass}>{summary}</div>
      )}
      <Switch checked={routine.enabled} onCheckedChange={onToggle} aria-label={routine.name} />
    </li>
  );
}

function MemoryList({
  files,
  onOpen,
  empty,
}: {
  files: ReadonlyArray<MemoryFile>;
  onOpen: (path: MemoryPath) => void;
  empty: string;
}) {
  const ctx = usePresentation();
  if (files.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="-mx-2 flex flex-col">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => onOpen(file.path)}
            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-start hover:bg-muted"
          >
            {file.path === "profile.md" ? (
              <NotebookTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">
              {memoryFileName(file.path, ctx.i18n)}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              {ctx.i18n.t("memory.sizeAndDate", {
                size: fileSize(file.size, ctx.i18n.locale),
                time: activityTime(file.updatedAt, ctx),
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface RoomDetailsIntents {
  readonly editRoom: () => void;
  /** Resolves once the server answered, whatever it said. */
  readonly archiveRoom: () => Promise<void>;
  /** Asks for members and a host first when the room lacks them. Resolves like `archiveRoom`. */
  readonly unarchiveRoom: () => Promise<void>;
  readonly deleteRoom: () => void;
}

/**
 * A room's details: who is in it, who hosts, how long bots may talk among
 * themselves, and what the operator does to the room itself.
 */
export function RoomDetails({
  room,
  intents,
  onClose,
  headingRef,
  headingId,
}: {
  room: Room;
  intents: RoomDetailsIntents;
  onClose: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  headingId?: string;
}) {
  const { t, plural } = useI18n();
  const bots = useBots();
  const { name } = room;
  const archived = room.status === "archived";
  return (
    <PanelFrame title={name} onClose={onClose} headingRef={headingRef} headingId={headingId}>
      {archived ? (
        <section className="border-b border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">{t("room.archivedLine")}</p>
        </section>
      ) : (
        <section className="border-b border-border px-4 py-4">
          <Button size="sm" onClick={intents.editRoom}>
            {t("room.edit", { name })}
          </Button>
        </section>
      )}
      <DetailsSection title={t("room.membersTitle")}>
        {room.members.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("room.noMembers")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {room.members.map((id) => {
              const bot = bots.get(id);
              if (!bot) return null;
              return (
                <li
                  key={id}
                  className="flex items-center gap-2.5 [--avatar-cutout:var(--background)]"
                >
                  <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={24} />
                  <span className="text-sm">{bot.profile.name}</span>
                  {bot.profile.title !== "" && (
                    <span className="text-xs text-muted-foreground">{bot.profile.title}</span>
                  )}
                  {id === room.hostId && (
                    <span className="ms-auto rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {t("room.host")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DetailsSection>
      <DetailsSection title={t("room.budget")}>
        <p className="text-sm">{plural("room.hopLimit", room.hopLimit)}</p>
      </DetailsSection>
      <section className="border-b border-border px-4 py-4">
        {archived ? (
          <PendingButton onPress={intents.unarchiveRoom}>
            {t("room.unarchive", { name })}
          </PendingButton>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-xs text-muted-foreground">{t("room.archive.hint")}</p>
            <PendingButton onPress={intents.archiveRoom}>
              {t("room.archive", { name })}
            </PendingButton>
          </div>
        )}
      </section>
      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <section className="px-4 py-4">
        <Confirm
          trigger={<Button size="sm" variant="destructive-outline" />}
          title={t("room.delete.title", { name })}
          body={t("room.delete.body", { name })}
          cancel={t("room.delete.cancel", { name })}
          confirm={t("room.delete", { name })}
          onConfirm={intents.deleteRoom}
        >
          {t("room.delete", { name })}
        </Confirm>
      </section>
    </PanelFrame>
  );
}

/** A button that takes no second press until what it started has an answer. */
function PendingButton({
  onPress,
  children,
}: {
  onPress: () => Promise<void>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      aria-disabled={pending}
      onClick={() => {
        if (pending) return;
        setPending(true);
        void onPress().finally(() => setPending(false));
      }}
    >
      {children}
    </Button>
  );
}
