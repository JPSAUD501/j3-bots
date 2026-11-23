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
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CirclePauseIcon,
  CpuIcon,
  FileTextIcon,
  NotebookTextIcon,
  PencilIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
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
import { RoomAvatar } from "./avatar/BotAvatar";
import { LiveBotAvatar } from "./avatar/mood";
import { FileCard } from "./FileCard";
import { Button } from "./ui/button";
import { SkeletonRows } from "./ui/skeleton";
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

/**
 * The details region's frame: a quiet bar with the pane's name, a back button
 * on a phone and a close button on wider layouts, over what scrolls.
 */
function PanelFrame({ title, onClose, headingRef, headingId, children }: PanelFrameProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 px-2">
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
          className="truncate px-2 text-sm font-semibold text-muted-foreground outline-none"
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
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">{children}</div>
    </div>
  );
}

/**
 * Who the pane is about, centered as on a profile: the picture, the name in
 * the display face, a quiet line under it, and the actions on it.
 */
function Profile({
  picture,
  name,
  badge,
  lines,
  actions,
}: {
  picture: ReactNode;
  name: string;
  badge?: ReactNode;
  lines: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col items-center px-5 pt-2 pb-5 text-center [--avatar-cutout:var(--background)]">
      {picture}
      <p className="mt-3 flex max-w-full items-center gap-2">
        <span className="display-type truncate text-2xl">{name}</span>
        {badge}
      </p>
      <div className="flex flex-col items-center gap-2 text-sm text-pretty text-muted-foreground">
        {lines}
      </div>
      {actions !== undefined && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </section>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 pt-5">
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A row of the details that opens something: it fills on hover and takes the row's press. */
const rowButton =
  "pressable pressable-row flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-start hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** A quiet sentence where a list would be. */
function Quiet({ children }: { children: ReactNode }) {
  return <p className="appear text-sm text-muted-foreground">{children}</p>;
}

/** What the danger zone holds: last and on its own, below a hairline. */
function Apart({ children }: { children: ReactNode }) {
  return (
    <section className="mx-5 mt-6 flex flex-col items-start gap-3 border-t border-border pt-5">
      {children}
    </section>
  );
}

export interface BotDetailsIntents {
  readonly setRoutineEnabled: (routineId: RoutineId, enabled: boolean) => void;
  /** Shows the routine's recent runs. */
  readonly openRoutine: (routineId: RoutineId) => void;
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
  const { name, title, job } = bot.profile;
  const mode = permissionModeText(bot.permissionMode, i18n);
  return (
    <PanelFrame
      title={t("conversation.details")}
      onClose={onClose}
      headingRef={headingRef}
      headingId={headingId}
    >
      <Profile
        picture={<LiveBotAvatar bot={bot} size={96} />}
        name={name}
        badge={bot.primary ? <Badge>{t("details.primary")}</Badge> : undefined}
        lines={
          <>
            {title !== "" && <span>{title}</span>}
            <span className="whitespace-pre-wrap">
              {job === "" ? t("details.noJob", { name }) : job}
            </span>
          </>
        }
        actions={
          intents.editProfile && (
            <Button size="sm" onClick={intents.editProfile}>
              <PencilIcon aria-hidden />
              {t("details.editProfile", { name })}
            </Button>
          )
        }
      />

      <DetailsSection title={t("details.routines")}>
        {routines === null ? (
          <SkeletonRows />
        ) : routines.length === 0 ? (
          <Quiet>{t("details.noRoutines", { name })}</Quiet>
        ) : (
          <ul className="appear -mx-2 flex flex-col">
            {routines.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                onToggle={(enabled) => intents.setRoutineEnabled(routine.id, enabled)}
                onOpen={() => intents.openRoutine(routine.id)}
              />
            ))}
          </ul>
        )}
      </DetailsSection>

      <DetailsSection title={t("details.files")}>
        {files === null ? (
          <SkeletonRows count={1} />
        ) : files.length === 0 ? (
          <Quiet>{t("details.noFiles", { name })}</Quiet>
        ) : (
          <div className="appear flex flex-col gap-1.5">
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
          <SkeletonRows count={1} />
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
          <div className="flex items-start gap-3">
            <CpuIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <dt className="sr-only">{t("details.runsOn")}</dt>
              <dd>{modelName ?? t("details.modelUnavailable")}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <dt className="sr-only">{t("details.permissionMode")}</dt>
              <dd>{mode.name}</dd>
              <dd className="text-xs text-muted-foreground">{mode.description}</dd>
            </div>
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
            <RotateCcwIcon aria-hidden />
            {t("details.freshStart")}
          </Confirm>
        </div>
      </DetailsSection>

      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <Apart>
        <DeleteBot name={name} onDelete={intents.deleteBot} />
      </Apart>
    </PanelFrame>
  );
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
      <Trash2Icon aria-hidden />
      {t("details.delete", { name })}
    </Confirm>
  );
}

/**
 * A routine: name, schedule in words, next run, last result, and a switch to
 * pause it. The rest of the row opens its recent runs.
 */
function RoutineRow({
  routine,
  onToggle,
  onOpen,
}: {
  routine: Routine;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}) {
  const ctx = usePresentation();
  const { pluralParts, t } = ctx.i18n;
  const lines = routineLines(routine, ctx);
  const Icon = !routine.enabled
    ? CirclePauseIcon
    : routine.trigger._tag === "webhook"
      ? WebhookIcon
      : CalendarClockIcon;
  return (
    <li className="flex items-center gap-1">
      <button type="button" onClick={onOpen} title={t("routine.runs.hint")} className={rowButton}>
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            routine.enabled ? "text-success" : "text-muted-foreground",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{routine.name}</span>
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
        </span>
      </button>
      <span className="shrink-0 pe-2">
        <Switch checked={routine.enabled} onCheckedChange={onToggle} aria-label={routine.name} />
      </span>
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
  if (files.length === 0) return <Quiet>{empty}</Quiet>;
  return (
    <ul className="appear -mx-2 flex flex-col">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => onOpen(file.path)}
            className={cn(rowButton, "items-center")}
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
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
  const members = room.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot ? [bot] : [];
  });
  return (
    <PanelFrame
      title={t("conversation.details")}
      onClose={onClose}
      headingRef={headingRef}
      headingId={headingId}
    >
      <Profile
        picture={<RoomAvatar
            members={members.map((bot) => ({ id: bot.id, avatar: bot.profile.avatar }))}
            size={96}
          />}
        name={name}
        badge={archived ? <Badge>{t("room.archivedBadge")}</Badge> : undefined}
        lines={
          archived ? (
            <span>{t("room.archivedLine")}</span>
          ) : (
            <span>{plural("room.memberCount", members.length)}</span>
          )
        }
        actions={
          archived ? undefined : (
            <Button size="sm" onClick={intents.editRoom}>
              <PencilIcon aria-hidden />
              {t("room.edit", { name })}
            </Button>
          )
        }
      />
      <DetailsSection title={t("room.membersTitle")}>
        {members.length === 0 ? (
          <Quiet>{t("room.noMembers")}</Quiet>
        ) : (
          <ul className="flex flex-col [--avatar-cutout:var(--background)]">
            {members.map((bot) => (
              <li key={bot.id} className="flex min-h-12 items-center gap-3 py-1.5">
                <LiveBotAvatar bot={bot} size={32} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{bot.profile.name}</span>
                  {bot.profile.title !== "" && (
                    <span className="truncate text-xs text-muted-foreground">
                      {bot.profile.title}
                    </span>
                  )}
                </span>
                {bot.id === room.hostId && <Badge>{t("room.host")}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </DetailsSection>
      <DetailsSection title={t("room.budget")}>
        <p className="text-sm">{plural("room.hopLimit", room.hopLimit)}</p>
      </DetailsSection>
      <DetailsSection title={t("room.archiveSection")}>
        {archived ? (
          <PendingButton onPress={intents.unarchiveRoom}>
            <ArchiveRestoreIcon aria-hidden />
            {t("room.unarchive", { name })}
          </PendingButton>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-xs text-muted-foreground">{t("room.archive.hint")}</p>
            <PendingButton onPress={intents.archiveRoom}>
              <ArchiveIcon aria-hidden />
              {t("room.archive", { name })}
            </PendingButton>
          </div>
        )}
      </DetailsSection>
      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <Apart>
        <Confirm
          trigger={<Button size="sm" variant="destructive-outline" />}
          title={t("room.delete.title", { name })}
          body={t("room.delete.body", { name })}
          cancel={t("room.delete.cancel", { name })}
          confirm={t("room.delete", { name })}
          onConfirm={intents.deleteRoom}
        >
          <Trash2Icon aria-hidden />
          {t("room.delete", { name })}
        </Confirm>
      </Apart>
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
