// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import type {
  Bot,
  CredentialFill,
  EntryPreview,
  WorkFoldEntry,
  WorkStep,
} from "@j3-bots/contracts";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  liveTurn,
  millisBetween,
  shortDuration,
  turnClock,
  turnElapsed,
} from "@j3-bots/client-runtime/presentation";
import { useSeconds } from "../app/clock";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import {
  fillDetail,
  stepText,
  turnLabel,
  turnLine,
  workFoldTitle,
} from "@j3-bots/client-runtime/wording";
import { LiveBotAvatar, useOffline } from "./avatar/mood";
import { CodeLines } from "./CodeLines";
import { toneClass } from "./RosterRow";
import { SwapText } from "./SwapText";

const stepIcon: Record<WorkStep["kind"], typeof TerminalIcon> = {
  command: TerminalIcon,
  edit: PencilIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  tool: WrenchIcon,
  delegation: BotIcon,
  other: EllipsisIcon,
};

/** The bot of a turn under way, as its row shows it. */
export interface TurnBot {
  readonly bot: Bot;
  /** The bot's latest entry, so its avatar speaks while a message of its own arrives. */
  readonly lastEntry: EntryPreview | null;
}

interface WorkFoldProps {
  /** The turn's fold; null for a turn under way that has done no work yet. */
  readonly fold: WorkFoldEntry | null;
  /** While the turn runs, its bot: the row says what it is doing, and for how long. */
  readonly live: TurnBot | null;
  /** The turn's steps once loaded; null while they load. */
  readonly steps: ReadonlyArray<WorkStep> | null;
  /**
   * True once the fold is open on screen, false once it closes or leaves the
   * screen: its steps are worth reading only meanwhile.
   */
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultOpen?: boolean;
}

/**
 * A turn's work in one row. While the turn runs: a small copy of the bot, one
 * line saying what it is doing now and the turn's clock. When it ends, the
 * row folds into one quiet line, "Worked for 2m", that opens to every step,
 * as the running row does once there are steps. Never opens by itself.
 */
export function WorkFold({ fold, live, steps, onOpenChange, defaultOpen = false }: WorkFoldProps) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const [open, setOpen] = useState(defaultOpen);
  const report = useEffectEvent(onOpenChange);
  useEffect(() => {
    if (!open) return;
    report(true);
    return () => report(false);
  }, [open]);
  // The row folds into its line once the turn it showed ends; one that was over when it mounted is just there.
  const [wasLive, setWasLive] = useState(live !== null);
  if (live !== null && !wasLive) setWasLive(true);
  const folding = live === null && wasLive;
  const hasSteps = fold !== null && fold.stepCount > 0;
  return (
    <Collapsible.Root
      open={open && hasSteps}
      onOpenChange={setOpen}
      className="mt-3 max-w-(--layout-card-width) self-start data-live:w-full"
      {...(live === null ? {} : { "data-live": "" })}
    >
      {live !== null ? (
        <LiveLine turn={live} hasSteps={hasSteps} />
      ) : fold !== null && !hasSteps ? (
        // A turn stopped or failed before its first step: how it ended, with nothing to open.
        <p
          className={cn(
            "flex min-h-8 items-center text-xs",
            folding && "arrive-pop origin-left",
            endTone(fold),
          )}
        >
          {workFoldTitle(fold, ctx)}
        </p>
      ) : fold !== null ? (
        <Collapsible.Trigger
          className={cn(
            "pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted hover:text-foreground",
            touchTarget,
            folding && "arrive-pop origin-left",
            endTone(fold),
          )}
        >
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90"
          />
          {/* A fold whose turn this client no longer sees running carries the quiet live mark. */}
          {fold.status._tag === "running" && <LiveMark />}
          <span>{workFoldTitle(fold, ctx)}</span>
          {/* The dot is its own item, so the line's gap stands on both sides of it. */}
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{plural("work.steps", fold.stepCount)}</span>
        </Collapsible.Trigger>
      ) : null}
      {hasSteps && (
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
          {steps === null ? (
            <p className="py-2 ps-5 text-xs text-muted-foreground">{t("work.loading")}</p>
          ) : (
            <ol className="mt-1.5 flex flex-col border-s border-border ps-3 ms-1.5">
              {steps.map((step) => {
                const Icon = stepIcon[step.kind];
                return (
                  <li key={step.id} className="flex min-h-7 items-start gap-2 py-1 text-xs">
                    <Icon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                    {/* Long commands and paths wrap: every step reads in full without a pointer. */}
                    {step.kind === "command" ? (
                      <span className="min-w-0 flex-1 font-mono text-2xs whitespace-pre-wrap wrap-anywhere">
                        <CodeLines text={step.label} />
                      </span>
                    ) : step.fill !== undefined ? (
                      <FillLine step={step} fill={step.fill} />
                    ) : (
                      <span className="min-w-0 flex-1 wrap-break-word">
                        {stepText(step, ctx.i18n)}
                      </span>
                    )}
                    <StepStatus step={step} />
                  </li>
                );
              })}
            </ol>
          )}
        </Collapsible.Panel>
      )}
    </Collapsible.Root>
  );
}

/**
 * A login's fill: which login and field, then where it was filled, or why it
 * was not, in the blocked tone, with the page's origin as the server checked it.
 */
function FillLine({ step, fill }: { readonly step: WorkStep; readonly fill: CredentialFill }) {
  const { i18n } = usePresentation();
  const detail = fillDetail(fill, i18n);
  return (
    <span className="flex min-w-0 flex-1 flex-col wrap-break-word">
      <span>{stepText(step, i18n)}</span>
      {detail !== "" && (
        <span className={fill.outcome._tag === "filled" ? "text-muted-foreground" : "text-blocked"}>
          {detail}
        </span>
      )}
    </span>
  );
}

/** A failed turn's line in the blocked tone; any other ending's quiet. */
const endTone = (fold: WorkFoldEntry) =>
  fold.status._tag === "finished" && fold.status.ending === "failed"
    ? "text-blocked"
    : "text-muted-foreground";

/**
 * The running row: the bot at list size in its state, what it is doing now,
 * swapping as it moves to a new step, and the turn's clock, counted from the
 * turn's start on the server. Once there are steps, a chevron opens them.
 * Assistive technology reads the line and the time so far in minutes, not
 * each tick, nor the visible line a second time; out of touch, only the line.
 * The conversation's header says each new line aloud.
 */
function LiveLine({ turn, hasSteps }: { readonly turn: TurnBot; readonly hasSteps: boolean }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const offline = useOffline();
  const started = liveTurn(turn.bot);
  // Out of touch, the client cannot say how long the turn has run: the clock stops showing.
  const now = useSeconds(started !== null && !offline);
  const line = turnLine(turn.bot, offline, ctx);
  const elapsed = started === null ? null : turnElapsed(started, now);
  return (
    <div className="flex min-h-8 items-center gap-2.5 text-xs">
      <LiveBotAvatar bot={turn.bot} lastEntry={turn.lastEntry} size={24} />
      <span className="min-w-0 flex-1">
        <span aria-hidden>
          <SwapText text={line.text} className={toneClass[line.tone]} />
        </span>
        <span className="sr-only">{turnLabel(line, offline ? null : elapsed, ctx)}</span>
      </span>
      {elapsed !== null && !offline && (
        <span
          aria-hidden
          className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums"
        >
          {turnClock(elapsed)}
        </span>
      )}
      {hasSteps && (
        <Collapsible.Trigger
          aria-label={t("work.showSteps")}
          className={cn(
            "pressable pressable-round group -me-1.5 flex size-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground hover:bg-muted hover:text-foreground",
            touchTarget,
          )}
        >
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90"
          />
        </Collapsible.Trigger>
      )}
    </div>
  );
}

function StepStatus({ step }: { step: WorkStep }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  switch (step.status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <LiveMark />
          {t("work.stepRunning")}
        </span>
      );
    case "failed":
      return <XIcon className="size-3.5 shrink-0 text-blocked" aria-label={t("work.stepFailed")} />;
    case "completed":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
          {step.finishedAt &&
            shortDuration(millisBetween(step.startedAt, step.finishedAt), ctx.i18n)}
          <CheckIcon className="size-3.5 shrink-0" aria-label={t("work.stepDone")} />
        </span>
      );
  }
}

/** A small dot that breathes while something runs; still under reduced motion. */
function LiveMark() {
  return <span aria-hidden className="live-mark size-1.5 shrink-0 rounded-pill bg-foreground/70" />;
}
