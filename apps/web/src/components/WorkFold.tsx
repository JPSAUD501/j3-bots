// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import type {
  Bot,
  CredentialFill,
  EntryPreview,
  WorkFoldEntry,
  WorkImageId,
  WorkStep,
} from "@j3-bots/contracts";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  GlobeIcon,
  ImageOffIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  liveTurn,
  millisBetween,
  shortDuration,
  shownPlan,
  turnClock,
  turnElapsed,
} from "@j3-bots/client-runtime/presentation";
import { resolveAvatar, springs } from "@j3-bots/design-tokens";
import { useSeconds } from "../app/clock";
import { useBots, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { touchTarget } from "../lib/touchTarget";
import {
  fillDetail,
  stepText,
  turnLabel,
  turnLine,
  workFoldTitle,
} from "@j3-bots/client-runtime/wording";
import { useImage } from "./attachmentImages";
import type { AvatarHandle } from "./avatar/BotAvatar";
import { LiveBotAvatar, useOffline } from "./avatar/mood";
import { CodeLines } from "./CodeLines";
import { LittleOnes } from "./LittleOnes";
import { PlanCard, PlanLine } from "./PlanCard";
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
  /** While the turn runs, what shows under its line, as the bot's browser. */
  readonly extra?: ReactNode;
  /** Shows large an image a step looked at. */
  readonly onOpenImage: (id: WorkImageId) => void;
}

/**
 * Plays the change of `root`'s height when its turn ends on screen: the plan's
 * card folds into its line, and what follows the row closes up on `slide`
 * instead of jumping. The height it starts from is the one last laid out,
 * which an observer keeps, since the little ones' block moves it between
 * renders.
 */
function useFoldedHeight(root: RefObject<HTMLDivElement | null>, folding: boolean) {
  const height = useRef<number | null>(null);
  const folded = useRef(folding);
  useEffect(() => {
    const element = root.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      height.current = element.offsetHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    const element = root.current;
    const from = height.current;
    if (element === null || !folding || folded.current) {
      folded.current = folding;
      return;
    }
    folded.current = true;
    const to = element.offsetHeight;
    if (from === null || Math.abs(from - to) < 2) return;
    play(
      element,
      [
        { height: `${from}px`, overflow: "clip" },
        { height: `${to}px`, overflow: "clip" },
      ],
      springs.slide,
    );
  }, [root, folding]);
}

/**
 * A turn's work in one row. While the turn runs: a small copy of the bot, one
 * line saying what it is doing now and the turn's clock; under it, the bot's
 * little ones while part of the work runs in parallel, and the turn's plan as
 * a short card. When it ends, the row folds into one quiet line, "Worked for
 * 2m", that opens to every step, as the running row does once there are
 * steps, and the plan into a line of its own, "Plan done, 4 of 4". Never opens
 * by itself.
 */
export function WorkFold({
  fold,
  live,
  steps,
  onOpenChange,
  defaultOpen = false,
  extra,
  onOpenImage,
}: WorkFoldProps) {
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
  const root = useRef<HTMLDivElement>(null);
  useFoldedHeight(root, folding);
  // The turn's plan and little ones, and the bot whose they are: the one at work, or the fold's author.
  const face = useRef<AvatarHandle>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const bots = useBots();
  const author =
    live?.bot ?? (fold?.author._tag === "bot" ? bots.get(fold.author.botId) : undefined);
  const work = fold?.work ?? null;
  const plan = shownPlan(work);
  return (
    <Collapsible.Root
      ref={root}
      open={open && hasSteps}
      onOpenChange={setOpen}
      className="mt-3 max-w-(--layout-card-width) self-start data-live:w-full"
      {...(live === null ? {} : { "data-live": "" })}
    >
      {live !== null ? (
        <>
          <LiveLine turn={live} hasSteps={hasSteps} face={face} anchor={anchor} />
        </>
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
      {/* For a turn seen running, and through its end, so the block it took closes instead of jumping shut. */}
      {author !== undefined && wasLive && (
        <LittleOnes
          littleOnes={work?.littleOnes ?? null}
          live={live !== null}
          avatar={author.profile.avatar}
          face={face}
          anchor={anchor}
        />
      )}
      {live !== null && plan !== null && (
        <PlanCard plan={plan} tint={resolveAvatar(live.bot.profile.avatar).color} />
      )}
      {live !== null && extra}
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
                    ) : step.image !== undefined ? (
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5 wrap-break-word">
                        <span>{stepText(step, ctx.i18n)}</span>
                        <StepImage id={step.image.id} onOpen={onOpenImage} />
                      </span>
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
      {live === null && plan !== null && <PlanLine plan={plan} folding={folding} />}
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

/**
 * The image a step looked at, small, in a frame of fixed size, so the list
 * never moves as it arrives; a click shows it large. One that cannot be had
 * any more says so in place of it.
 */
function StepImage({
  id,
  onOpen,
}: {
  readonly id: WorkImageId;
  readonly onOpen: (id: WorkImageId) => void;
}) {
  const { t } = usePresentation().i18n;
  const image = useImage({ _tag: "work", id });
  // A file that stopped decoding as an image since the server checked it is as gone.
  const [undrawable, setUndrawable] = useState(false);
  const frame = "size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted";
  if (image?._tag === "failed" || undrawable) {
    return (
      <span
        role="img"
        aria-label={t("work.image.unavailable")}
        title={t("work.image.unavailable")}
        className={cn(frame, "flex items-center justify-center text-muted-foreground")}
      >
        <ImageOffIcon aria-hidden className="size-4" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      aria-label={t("work.image.open")}
      className={cn("pressable hover:opacity-90", frame)}
    >
      {image?._tag === "shown" && (
        <img
          src={image.url}
          alt=""
          onError={() => setUndrawable(true)}
          className="size-full object-cover"
        />
      )}
    </button>
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
function LiveLine({
  turn,
  hasSteps,
  face,
  anchor,
}: {
  readonly turn: TurnBot;
  readonly hasSteps: boolean;
  /** The bot's face, for its little ones to make it answer. */
  readonly face: RefObject<AvatarHandle | null>;
  /** What frames that face: its little ones come out from under it. */
  readonly anchor: RefObject<HTMLSpanElement | null>;
}) {
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
      {/* Above its little ones, which come out from behind it. */}
      <span ref={anchor} className="relative z-2 flex shrink-0">
        <LiveBotAvatar bot={turn.bot} lastEntry={turn.lastEntry} size={24} ref={face} />
      </span>
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
