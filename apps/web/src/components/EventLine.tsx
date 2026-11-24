// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type { BotId, EntryId, PairBotIds, RoutineId } from "@j3-bots/contracts";
import {
  type EventLine as Line,
  eventLineOpens,
  type RoutineChanges,
  type TeammateRun,
} from "@j3-bots/client-runtime/presentation";
import {
  type EventIcon,
  type EventLineWords,
  type EventMark,
  eventLineWords,
  routineChangeDetail,
  teammateChoice,
} from "@j3-bots/client-runtime/wording";
import {
  CalendarClockIcon,
  ChevronRightIcon,
  CirclePauseIcon,
  type LucideIcon,
  MessagesSquareIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useBot, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { BotAvatar } from "./avatar/BotAvatar";
import { FaceOf } from "./avatar/TeamAvatars";

/** Opens the conversation between two bots at a teammate message, by the card of it a line holds. */
export type OpenPair = (botIds: PairBotIds, at: EntryId) => void;

const icons: Record<EventIcon, LucideIcon> = {
  routine: CalendarClockIcon,
  webhook: WebhookIcon,
  paused: CirclePauseIcon,
  deleted: Trash2Icon,
  message: MessagesSquareIcon,
};

const markTone: Record<EventMark["tone"], string> = {
  waiting: "text-waiting",
  blocked: "text-blocked",
  quiet: "text-muted-foreground",
};

/**
 * On a touch screen a line takes its whole row, edge to edge and 32 px tall,
 * in place of the row's padding: a row that wide is easy to hit, and its
 * target never reaches into the next row. A fine pointer keeps the line as
 * tall as its text.
 */
const coarseRow =
  "pointer-coarse:min-h-8 pointer-coarse:w-full pointer-coarse:justify-center pointer-coarse:px-4";

const control = cn(
  "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-center transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent data-popup-open:text-foreground pointer-coarse:rounded-none",
  coarseRow,
);

/**
 * Something that happened, told in one quiet centred line about as tall as a
 * time between messages: a teammate's face or a glyph, then a short sentence
 * with the name in medium weight. A line with more to show opens it: a run
 * of teammate messages, their teammate conversation at the run, or first a
 * popover of the conversations when the run has several teammates; the
 * routines of a line that tells several, in a popover; a routine, in the
 * details panel. The rest only tell.
 */
export function EventLine({
  line,
  onOpenRoutine,
  onOpenPair,
}: {
  line: Line;
  onOpenRoutine: (routineId: RoutineId) => void;
  onOpenPair: OpenPair;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const words = eventLineWords(line, ctx);
  const opens = eventLineOpens(line);
  const sentence = <Sentence words={words} />;
  const title = words.runs.map((run) => run.text).join("");
  const popover = (hint: string, content: ReactNode) => (
    <Popover.Root>
      <Popover.Trigger aria-label={words.label} aria-description={hint} className={control}>
        {sentence}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={6} className="z-50">
          <Popover.Popup className="flex max-h-[min(28rem,var(--available-height))] w-[min(26rem,calc(100vw-2rem))] origin-(--transform-origin) flex-col rounded-lg border border-border bg-surface text-sm text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out">
            {content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
  return (
    <div className="flex justify-center px-4 py-1.5 text-2xs text-muted-foreground pointer-coarse:p-0">
      {opens === null ? (
        <p className={cn("inline-flex max-w-full items-center gap-1.5 text-center", coarseRow)}>
          {sentence}
        </p>
      ) : opens._tag === "pair" ? (
        <button
          type="button"
          aria-label={words.label}
          aria-description={t("eventLine.opensPair")}
          onClick={() => onOpenPair(opens.pair.botIds, opens.pair.first)}
          className={control}
        >
          {sentence}
        </button>
      ) : opens._tag === "pairs" ? (
        popover(t("eventLine.opensPairs"), <Pairs pairs={opens.pairs} onOpenPair={onOpenPair} />)
      ) : opens._tag === "routine" ? (
        <button
          type="button"
          aria-label={words.label}
          aria-description={t("eventLine.opensRoutine")}
          onClick={() => onOpenRoutine(opens.routineId)}
          className={control}
        >
          {sentence}
        </button>
      ) : (
        popover(
          t("eventLine.opensRoutines"),
          <Routines title={title} changes={opens.changes} onOpenRoutine={onOpenRoutine} />,
        )
      )}
    </div>
  );
}

function Sentence({ words }: { words: EventLineWords }) {
  const Icon = words.lead._tag === "icon" ? icons[words.lead.icon] : null;
  return (
    <>
      {words.lead._tag === "bot" ? (
        <Face botId={words.lead.botId} size={16} />
      ) : (
        Icon !== null && <Icon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0">
        {words.runs.map((run) =>
          run.strong ? (
            <span key={run.at} className="font-medium">
              {run.text}
            </span>
          ) : (
            run.text
          ),
        )}
        {words.status !== null && (
          <>
            <span aria-hidden> · </span>
            <span className={cn("font-medium", markTone[words.status.tone])}>
              {words.status.text}
            </span>
          </>
        )}
      </span>
    </>
  );
}

/** A teammate's face, still: the words name it, so its face says nothing more. */
function Face({ botId, size }: { botId: BotId; size: number }) {
  const bot = useBot(botId);
  return bot === null ? null : (
    <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={size} still />
  );
}

/** The teammates of a run with several: each one's conversation with the bot, opened at the run. */
function Pairs({ pairs, onOpenPair }: { pairs: TeammateRun["pairs"]; onOpenPair: OpenPair }) {
  const ctx = usePresentation();
  return (
    <>
      <Popover.Title className="px-4 pt-3.5 pb-1.5 font-medium">
        {ctx.i18n.t("pairs.chooser")}
      </Popover.Title>
      <ul className="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5 [--avatar-cutout:var(--surface)]">
        {pairs.map((pair) => {
          const choice = teammateChoice(pair, ctx);
          return (
            <li key={pair.peer}>
              <Popover.Close
                onClick={() => onOpenPair(pair.botIds, pair.first)}
                className={cn(
                  "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start outline-none hover:bg-muted focus-visible:bg-muted",
                  touchTarget,
                )}
              >
                <FaceOf botId={pair.peer} size={28} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{choice.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{choice.detail}</span>
                </span>
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </Popover.Close>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The routines of a line that tells several: each named over when it runs, and opened from here. */
function Routines({
  title,
  changes,
  onOpenRoutine,
}: {
  title: string;
  changes: RoutineChanges;
  onOpenRoutine: (routineId: RoutineId) => void;
}) {
  const ctx = usePresentation();
  return (
    <>
      <Popover.Title className="px-4 pt-3.5 pb-1.5 font-medium">{title}</Popover.Title>
      <ul className="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5">
        {changes.map((change) => {
          const detail = routineChangeDetail(change, ctx);
          const rows = (
            <span className="flex min-w-0 flex-1 flex-col items-start text-start">
              <span className="w-full truncate font-medium">{change.name}</span>
              {detail !== null && (
                <span className="w-full truncate text-xs text-muted-foreground">{detail}</span>
              )}
            </span>
          );
          return (
            <li key={change.routineId}>
              {change.change === "deleted" ? (
                <div className="flex px-2.5 py-1.5">{rows}</div>
              ) : (
                <Popover.Close
                  onClick={() => onOpenRoutine(change.routineId)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted",
                    touchTarget,
                  )}
                >
                  {rows}
                  <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </Popover.Close>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
