// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import {
  type AvatarState,
  currentStation,
  inkTo,
  miniRail,
  runSteps,
  type Station,
  stationKey,
  type StationOf,
  trackAttention,
  trackStations,
  trackStatus,
  type TrackStatus,
  type TrackTrigger,
  trackWindow,
} from "@j3-bots/client-runtime/presentation";
import {
  botStationSub,
  botStationTitle,
  conditionTitle,
  endReason,
  failureHelp,
  foldLine,
  keyedRuns,
  routineSentence,
  stationStateText,
  trackTag,
  triggerInWords,
  youStationLines,
} from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  BotId,
  EntryId,
  RoutineAnswer,
  RoutineRun,
  RoutineStep,
} from "@j3-bots/contracts";
import { resolveAvatar } from "@j3-bots/design-tokens";
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  MinusIcon,
  PlugZapIcon,
  UserIcon,
  WebhookIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useBots, useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { sprung } from "../lib/sprung";
import { touchTarget } from "../lib/touchTarget";
import { type AvatarHandle, BotAvatar } from "./avatar/BotAvatar";
import { reducedMotion } from "./avatar/ticker";
import { CardFrame } from "./CardFrame";
import { SwapText } from "./SwapText";
import { Button } from "./ui/button";

/** The mark column, in px: the line runs down its middle. */
const MARK = 28;
const LINE_X = MARK / 2;
/** The text column starts here, in px. */
const TEXT_X = MARK + 12;
/** The gap the line leaves at every mark, in px. */
const GAP = 4;
/** How long a finished run stays drawn whole before it folds into its line, in ms. */
const FOLD_AFTER = 900;

/** The operator's answer to a yes, from the ask that shows it. */
type Reply = (choice: RoutineAnswer["choice"], note: string | null) => void;
/** The operator's answer to the yes at `step` of the run, which is the one they saw. */
type Answer = (step: number, choice: RoutineAnswer["choice"], note: string | null) => void;

export interface RoutineTrackProps {
  readonly entryId: EntryId;
  readonly name: string;
  readonly trigger: TrackTrigger;
  /**
   * The bot whose routine it is, which a failed step names. A run's entry is
   * always its owner's; a change the operator made does not say, and needs it
   * not, having no run.
   */
  readonly owner: BotId | null;
  /** The routine's steps; a run draws the steps it copied instead. */
  readonly steps: ReadonlyArray<RoutineStep>;
  /** The run the card follows, or null for the routine at rest. */
  readonly run: RoutineRun | null;
  /** The routine was just made in front of the operator: its stations come in, top to bottom. */
  readonly arriving?: boolean;
  /** An answer, a Try again or a Stop is on its way. */
  readonly submitting?: boolean;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
  readonly onStop?: () => void;
}

/**
 * A routine with several steps, drawn as its track (decision 0080): the
 * card's title is the routine's name, the sentence under it reads the
 * routine back, and the rail shows its trigger and each step, who does it
 * and, in a run, where it stands. The step at work is its bot's own face on a
 * lit row; a light passes down the line from one step to the next. A yes
 * opens inside its stop; a failed step says what happened, what to do and
 * what is kept, with one action. A finished run folds into one line.
 */
export function RoutineTrack(props: RoutineTrackProps) {
  const { run } = props;
  const status = trackStatus(run);
  const ended = status === "done" || status === "stopped-quietly";
  const [endedAtFirst] = useState(ended);
  // Once folded it stays so; a run that ends again folds again after its pause.
  const [folded, setFolded] = useState(ended);
  useEffect(() => {
    if (!ended) return;
    const timer = window.setTimeout(() => setFolded(true), reducedMotion() ? 0 : FOLD_AFTER);
    return () => window.clearTimeout(timer);
  }, [ended]);
  if (ended && folded && run !== null) {
    return <TrackFold {...props} run={run} folding={!endedAtFirst} />;
  }
  return <TrackCard {...props} status={status} />;
}

function TriggerIcon({ trigger }: { readonly trigger: TrackTrigger }) {
  switch (trigger._tag) {
    case "webhook":
      return <WebhookIcon />;
    case "event":
      return <PlugZapIcon />;
    case "once":
    case "schedule":
      return <CalendarClockIcon />;
  }
}

function TrackCard({
  entryId,
  name,
  trigger,
  owner,
  steps,
  run,
  status,
  arriving = false,
  submitting = false,
  onAnswer,
  onRetry,
  onStop,
}: RoutineTrackProps & { readonly status: TrackStatus }) {
  const ctx = usePresentation();
  const sentenceId = useId();
  const attention = trackAttention(status);
  const going = status === "running" || status === "waiting";
  return (
    <CardFrame
      icon={<TriggerIcon trigger={trigger} />}
      title={name}
      attention={attention === "blocked" ? "blocked" : attention === "waiting"}
      tag={trackTag(status, ctx)}
      entryId={entryId}
      describedBy={sentenceId}
    >
      <RoutineSentence
        id={sentenceId}
        trigger={trigger}
        steps={runSteps(steps, run)}
        className="-mt-1.5 block text-sm text-muted-foreground"
      />
      <Rail
        name={name}
        trigger={trigger}
        owner={owner}
        stations={trackStations(steps, run)}
        retryable={run?.retryable === true}
        arriving={arriving}
        submitting={submitting}
        {...(onAnswer === undefined ? {} : { onAnswer })}
        {...(onRetry === undefined ? {} : { onRetry })}
      />
      {going && onStop !== undefined && (
        <div className="-mt-1 flex justify-end">
          <Button
            variant="ghost-muted"
            size="sm"
            aria-disabled={submitting}
            onClick={() => {
              if (!submitting) onStop();
            }}
          >
            {ctx.i18n.t("routine.track.stop")}
          </Button>
        </div>
      )}
    </CardFrame>
  );
}

/**
 * The routine read back in one sentence, built from its steps: bot names in
 * the foreground, "you" in the waiting color.
 */
export function RoutineSentence({
  trigger,
  steps,
  id,
  className,
}: {
  readonly trigger: TrackTrigger;
  readonly steps: ReadonlyArray<RoutineStep>;
  readonly id?: string;
  readonly className?: string;
}) {
  const ctx = usePresentation();
  return (
    <span id={id} className={className}>
      {keyedRuns(routineSentence(trigger, steps, ctx)).map((run) => (
        <span
          key={run.key}
          className={cn(
            run.tone === "bot" && "font-medium text-foreground",
            run.tone === "you" && "font-medium text-waiting",
          )}
        >
          {run.text}
        </span>
      ))}
    </span>
  );
}

/** Where the rail's marks sit, measured: each centre and how far its drawn part reaches. */
interface Measured {
  readonly marks: ReadonlyArray<{ readonly y: number; readonly reach: number }>;
  /** Where each condition's siding words sit, by the station's place among those shown. */
  readonly sidings: ReadonlyMap<number, number>;
  readonly height: number;
}

/** How far a station's drawn mark reaches from its centre, in px: a face is 22 or 28. */
const reachOf = (station: Station): number => {
  switch (station._tag) {
    case "bot":
      return station.state === "doing" || station.state === "failed" ? 14 : 11;
    case "condition":
      return 7;
    default:
      return 11;
  }
};

/** A bot's own color, as a CSS value; muted for a bot that is gone. */
function botInk(botId: BotId, bots: ReadonlyMap<BotId, Bot>): string {
  const bot = bots.get(botId);
  return bot === undefined
    ? "var(--muted-foreground)"
    : `var(--bot-${resolveAvatar(bot.profile.avatar).color})`;
}

/** The light's color at a station: its bot's own, the waiting color at the stop, ink at the trigger. */
function lightColor(station: Station | undefined, bots: ReadonlyMap<BotId, Bot>): string {
  switch (station?._tag) {
    case "bot":
      return botInk(station.botId, bots);
    case "you":
      return "var(--waiting)";
    default:
      return "var(--foreground)";
  }
}

interface RailProps {
  readonly name: string;
  readonly trigger: TrackTrigger;
  readonly owner: BotId | null;
  readonly stations: ReadonlyArray<Station>;
  readonly retryable: boolean;
  readonly arriving?: boolean;
  readonly submitting?: boolean;
  /** Quick access: only the stations around where the run is, with the rest counted. */
  readonly windowed?: boolean;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
}

/**
 * The rail: the stations in an ordered list, and under them one line,
 * measured on the stations' size (never per frame). Grey ahead, ink behind,
 * a gap at every mark, a condition's siding ending at its bar.
 */
function Rail({
  name,
  trigger,
  owner,
  stations,
  retryable,
  arriving = false,
  submitting = false,
  windowed = false,
  onAnswer,
  onRetry,
}: RailProps) {
  const ctx = usePresentation();
  const { plural } = ctx.i18n;
  const list = useRef<HTMLOListElement>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const view = windowed ? trackWindow(stations) : null;
  const offset = view?.from ?? 0;
  const shown = view === null ? stations : stations.slice(view.from, view.to + 1);
  const reachKey = shown.map(reachOf).join(",");

  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) return;
    const reaches = reachKey.split(",").map(Number);
    const measure = () => {
      const top = element.getBoundingClientRect().top;
      const marks = [...element.querySelectorAll<HTMLElement>("[data-mark]")].map((mark, at) => {
        const box = mark.getBoundingClientRect();
        return { y: box.top - top + box.height / 2, reach: reaches[at] ?? 11 };
      });
      const sidings = new Map<number, number>();
      for (const words of element.querySelectorAll<HTMLElement>("[data-siding]")) {
        const box = words.getBoundingClientRect();
        sidings.set(Number(words.dataset.siding), box.top - top + box.height / 2);
      }
      setMeasured({ marks, sidings, height: element.scrollHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reachKey]);

  const current = currentStation(stations);
  const at = current === null ? undefined : stations[current];
  const reason = endReason(stations, ctx);

  return (
    <div>
      {view !== null && view.before > 0 && (
        <p className="plan-count ps-10">{plural("routine.window.done", view.before)}</p>
      )}
      <div className="relative">
        {measured !== null && (
          <RailLine
            measured={measured}
            shown={shown}
            ink={inkTo(stations) - offset}
            current={current === null ? null : current - offset}
          />
        )}
        <ol
          ref={list}
          aria-label={plural("routine.track.label", stations.length - 1, { name })}
          className="relative flex flex-col"
        >
          {shown.map((station, place) => (
            <StationRow
              key={stationKey(station)}
              station={station}
              place={place}
              stations={stations}
              trigger={trigger}
              owner={owner}
              reason={reason}
              retryable={retryable}
              submitting={submitting}
              entering={arriving ? place : null}
              {...(onAnswer === undefined ? {} : { onAnswer })}
              {...(onRetry === undefined ? {} : { onRetry })}
            />
          ))}
        </ol>
      </div>
      {view !== null && view.after > 0 && (
        <p className="plan-count ps-10">{plural("routine.window.after", view.after)}</p>
      )}
      {/* Each step that starts, said once, politely. */}
      <p aria-live="polite" className="sr-only">
        {at?._tag === "bot" && at.state === "doing" ? botStationTitle(at, ctx) : ""}
      </p>
    </div>
  );
}

/**
 * The line under the stations, and the light that passes down it from the
 * station the run left to the one it reached. The light moves on the frame
 * loop by transform alone; the ink behind it follows its own position.
 */
function RailLine({
  measured,
  shown,
  ink,
  current,
}: {
  readonly measured: Measured;
  readonly shown: ReadonlyArray<Station>;
  readonly ink: number;
  readonly current: number | null;
}) {
  const bots = useBots();
  const { marks, sidings, height } = measured;

  // The light: one leg at a time, from the station the run left to the one it reached.
  const previous = useRef(current);
  const [leg, setLeg] = useState<{ readonly from: number; readonly to: number } | null>(null);
  useEffect(() => {
    const from = previous.current;
    previous.current = current;
    if (from === null || current === null || current <= from || reducedMotion()) return;
    setLeg({ from, to: current });
  }, [current]);

  const dot = useRef<SVGGElement>(null);
  const arriving = useRef<SVGGElement>(null);
  const fill = useRef<SVGLineElement>(null);
  const a = leg === null ? undefined : marks[leg.from];
  const b = leg === null ? undefined : marks[leg.to];
  const y0 = a === undefined ? 0 : a.y + a.reach + GAP;
  const y1 = b === undefined ? 0 : b.y - b.reach - GAP;
  useEffect(() => {
    const light = dot.current;
    if (leg === null || light === null) return;
    const motion = sprung(
      { p: 0 },
      "slide",
      ({ p }) => {
        const y = y0 + (y1 - y0) * p;
        // Off over the face's shoulder at the start, a hop onto the next mark at the end.
        const off = p < 0.2 ? Math.sin((Math.PI * p) / 0.2) * 7 : 0;
        const onto = p > 0.86 ? Math.sin((Math.PI * (p - 0.86)) / 0.14) * -4 : 0;
        const seen = p > 0.94 ? Math.max(0, (1 - p) / 0.06) : Math.min(1, p / 0.04);
        light.style.transform = `translate(${LINE_X + off}px, ${y + onto}px) scale(${0.5 + seen / 2})`;
        light.style.opacity = String(seen);
        arriving.current?.style.setProperty("opacity", String(p));
        fill.current?.setAttribute("y2", String(Math.max(y0, y)));
      },
      () => setLeg(null),
    );
    motion.to({ p: 1 }, { delay: 120 });
    return () => motion.stop();
  }, [leg, y0, y1]);

  const stoppedAt = shown.findIndex(
    (station) => station._tag === "condition" && station.state === "stopped",
  );
  const segments: Array<{ readonly at: number; readonly from: number; readonly to: number }> = [];
  for (let at = 0; at + 1 < marks.length; at++) {
    const here = marks[at];
    const next = marks[at + 1];
    // Past a condition that stopped the run, the main line ends.
    if (here === undefined || next === undefined || (stoppedAt !== -1 && at >= stoppedAt)) continue;
    const from = here.y + here.reach + GAP;
    const to = next.y - next.reach - GAP;
    if (to > from) segments.push({ at, from, to });
  }
  // The leg the light runs is grey until the light's own fill reaches along it.
  const inked = (at: number) => at + 1 <= ink && (leg === null || at < leg.from || at >= leg.to);

  const sidingPaths = shown.flatMap((station, at) => {
    if (station._tag !== "condition") return [];
    const mark = marks[at];
    const words = sidings.get(at);
    if (mark === undefined || words === undefined) return [];
    const barX = TEXT_X - GAP - 2;
    return [
      {
        at,
        d: `M ${LINE_X} ${mark.y + mark.reach + 1} Q ${LINE_X} ${words} ${LINE_X + 12} ${words} L ${barX - 2} ${words}`,
        barX,
        barY: words - 4.5,
        state: station.state,
      },
    ];
  });
  const stopped = sidingPaths.find((siding) => siding.state === "stopped");

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-visible"
      width="100%"
      height={height}
    >
      {segments.map((segment) => (
        <line
          key={segment.at}
          x1={LINE_X}
          x2={LINE_X}
          y1={segment.from}
          y2={segment.to}
          strokeWidth={2}
          strokeLinecap="round"
          className={cn(
            "transition-[stroke] duration-(--duration-state)",
            inked(segment.at) ? "stroke-muted-foreground" : "stroke-input",
          )}
        />
      ))}
      {leg !== null && (
        <line
          ref={fill}
          x1={LINE_X}
          x2={LINE_X}
          y1={y0}
          y2={y0}
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-muted-foreground"
        />
      )}
      {sidingPaths.map((siding) => (
        <g
          key={siding.at}
          className={cn(
            "transition-opacity duration-(--duration-state)",
            siding.state === "passed" && "opacity-45",
          )}
        >
          <path
            d={siding.d}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            className={siding.state === "stopped" ? "stroke-muted-foreground" : "stroke-input"}
          />
          <rect
            x={siding.barX}
            y={siding.barY}
            width={2}
            height={9}
            rx={1}
            className={siding.state === "stopped" ? "fill-muted-foreground" : "fill-input"}
          />
        </g>
      ))}
      {/* A run that stopped at a condition: its light rests at the siding's bar, grey. */}
      {stopped !== undefined && (
        <circle
          cx={stopped.barX - 6}
          cy={stopped.barY + 4.5}
          r={4}
          className="pop-in fill-muted-foreground"
        />
      )}
      {leg !== null && (
        <g ref={dot} style={{ opacity: 0 }}>
          <g style={{ fill: lightColor(shown[leg.from], bots) }}>
            <circle r={7} opacity={0.22} />
            <circle r={4} />
          </g>
          <g ref={arriving} style={{ fill: lightColor(shown[leg.to], bots), opacity: 0 }}>
            <circle r={7} opacity={0.22} />
            <circle r={4} />
          </g>
        </g>
      )}
    </svg>
  );
}

interface StationRowProps {
  readonly station: Station;
  /** Its place among the stations shown. */
  readonly place: number;
  readonly stations: ReadonlyArray<Station>;
  readonly trigger: TrackTrigger;
  readonly owner: BotId | null;
  /** Why the steps after the run's end were skipped. */
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly submitting: boolean;
  /** Its turn to come in, for a routine just made; null otherwise. */
  readonly entering: number | null;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
}

/** What lights a station's row: its bot at work, the operator's stop, a step that failed. */
const litOf = (station: Station): "bot" | "waiting" | "blocked" | null => {
  if (station._tag === "bot") {
    return station.state === "doing" ? "bot" : station.state === "failed" ? "blocked" : null;
  }
  return station._tag === "you" && station.state === "waiting" ? "waiting" : null;
};

function StationRow(props: StationRowProps) {
  const { station, entering } = props;
  const ctx = usePresentation();
  const bots = useBots();
  const bot = station._tag === "bot" ? bots.get(station.botId) : undefined;
  const stands = stationStateText(station, ctx);
  const style: CSSProperties & Partial<Record<"--track-lit", string>> = {
    ...(bot === undefined
      ? {}
      : { "--track-lit": `var(--bot-lit-${resolveAvatar(bot.profile.avatar).color})` }),
    ...(entering === null ? {} : { animationDelay: `${entering * 60}ms` }),
  };
  return (
    <li
      data-kind={station._tag}
      data-lit={litOf(station) ?? undefined}
      data-state={station._tag === "trigger" ? "rest" : station.state}
      style={style}
      className={cn("track-station", entering !== null && "track-enter")}
    >
      <span data-mark className="track-mark">
        <StationMark station={station} trigger={props.trigger} />
      </span>
      <div className="min-w-0">
        {stands !== null && <span className="sr-only">{stands}: </span>}
        <StationText {...props} />
      </div>
    </li>
  );
}

/** A station's mark: the trigger's disc, the bot's face, a condition's diamond, the operator's stop. */
function StationMark({
  station,
  trigger,
}: {
  readonly station: Station;
  readonly trigger: TrackTrigger;
}) {
  switch (station._tag) {
    case "trigger":
      return (
        <span className="track-disc bg-muted text-muted-foreground">
          <TriggerIcon trigger={trigger} />
        </span>
      );
    case "bot":
      return <BotFace station={station} />;
    case "condition":
      return (
        <span
          className="track-diamond"
          data-judged={station.state === "passed" || station.state === "stopped" || undefined}
        />
      );
    case "you":
      return <YouMark station={station} />;
  }
}

const faceState = (station: StationOf<"bot">): AvatarState =>
  station.state === "doing" ? "working" : station.state === "failed" ? "blocked" : "idle";

/**
 * A bot step's face: full size and at work while its step runs, smaller and
 * idle otherwise, with the plan's check once done. It catches the light as
 * its step starts, smiles as it ends, and sulks when it fails.
 */
function BotFace({ station }: { readonly station: StationOf<"bot"> }) {
  const bot = useBots().get(station.botId);
  const handle = useRef<AvatarHandle>(null);
  const previous = useRef(station.state);
  const [doneAtFirst] = useState(station.state === "done");
  useEffect(() => {
    const was = previous.current;
    previous.current = station.state;
    if (was === station.state) return;
    if (station.state === "doing") handle.current?.poke("catch");
    else if (station.state === "done" && was === "doing") handle.current?.poke("smile");
    else if (station.state === "failed") handle.current?.poke("sulk");
  }, [station.state]);
  const big = station.state === "doing" || station.state === "failed";
  return (
    <span className="track-face" data-big={big || undefined}>
      {bot === undefined ? (
        <span className="track-disc bg-muted" />
      ) : (
        <BotAvatar
          ref={handle}
          avatar={bot.profile.avatar}
          seed={bot.id}
          state={faceState(station)}
          size={MARK}
          cutout
        />
      )}
      {station.state === "done" && (
        <span className={cn("track-check plan-mark plan-mark-done", !doneAtFirst && "pop-in")}>
          <CheckIcon aria-hidden className={cn("size-2.5", !doneAtFirst && "draw-check")} />
        </span>
      )}
    </span>
  );
}

/** The operator's stop: an amber ring at rest, filled with its ping while it waits for them. */
function YouMark({ station }: { readonly station: StationOf<"you"> }) {
  return (
    <span className="track-face" data-big>
      <span
        className="track-disc track-you"
        data-waiting={station.state === "waiting" || undefined}
        data-timed-out={station.state === "timed-out" || undefined}
      >
        <UserIcon aria-hidden />
      </span>
      {(station.state === "yes" || station.state === "no") && (
        <span className="track-check plan-mark plan-mark-done pop-in">
          {station.state === "yes" ? (
            <CheckIcon aria-hidden className="size-2.5" />
          ) : (
            <MinusIcon aria-hidden className="size-2.5" />
          )}
        </span>
      )}
    </span>
  );
}

function StationText({
  station,
  place,
  stations,
  trigger,
  owner,
  reason,
  retryable,
  submitting,
  onAnswer,
  onRetry,
}: StationRowProps) {
  const ctx = usePresentation();
  switch (station._tag) {
    case "trigger":
      return <p className="track-title">{triggerInWords(trigger, ctx)}</p>;
    case "bot": {
      const sub = botStationSub(station, reason, ctx);
      return (
        <>
          <p className="track-title">{botStationTitle(station, ctx)}</p>
          {sub !== null && (
            <SwapText
              text={sub}
              className={cn("track-sub", station.state === "failed" && "text-foreground")}
            />
          )}
          {station.state === "failed" && owner !== null && (
            <FailureHelp
              station={station}
              stations={stations}
              owner={owner}
              retryable={retryable}
              submitting={submitting}
              {...(onRetry === undefined ? {} : { onRetry })}
            />
          )}
        </>
      );
    }
    case "condition":
      return (
        <>
          <SwapText text={conditionTitle(station, ctx)} className="track-gate" />
          <p data-siding={place} className="track-siding">
            {ctx.i18n.t("routine.gate.otherwise")}
          </p>
        </>
      );
    case "you": {
      const lines = youStationLines(station, reason, ctx);
      return (
        <>
          <p className="track-title">{lines.title}</p>
          {lines.sub !== null && <p className="track-sub">{lines.sub}</p>}
          {station.state === "waiting" && station.ask !== null && onAnswer !== undefined && (
            <YesAsk
              yes={station.ask.yes}
              no={station.ask.no}
              submitting={submitting}
              onAnswer={(choice, note) => onAnswer(station.index, choice, note)}
            />
          )}
        </>
      );
    }
  }
}

/**
 * What the yes asks, opened inside its stop: its two choices and a note, as
 * a question card takes them. The choice pressed holds while its answer is
 * on its way.
 */
function YesAsk({
  yes,
  no,
  submitting,
  onAnswer,
}: {
  readonly yes: string;
  readonly no: string;
  readonly submitting: boolean;
  readonly onAnswer: Reply;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [pressed, setPressed] = useState<RoutineAnswer["choice"] | null>(null);
  const answer = (choice: RoutineAnswer["choice"]) => {
    if (submitting) return;
    setPressed(choice);
    const kept = note.trim();
    onAnswer(choice, kept === "" ? null : kept);
  };
  return (
    <div className="arrive mt-2 flex flex-col gap-2">
      <textarea
        rows={1}
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        placeholder={t("question.addNote")}
        aria-label={t("question.addNote")}
        className="field-sizing-content min-h-9 resize-none rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          aria-disabled={submitting}
          className={cn(submitting && pressed !== "yes" && "opacity-50")}
          onClick={() => answer("yes")}
        >
          {yes}
        </Button>
        <Button
          variant="outline"
          aria-disabled={submitting}
          className={cn(submitting && pressed !== "no" && "opacity-50")}
          onClick={() => answer("no")}
        >
          {no}
        </Button>
      </div>
    </div>
  );
}

/** Under a failed step: what to do and what is kept, then its one action. */
function FailureHelp({
  station,
  stations,
  owner,
  retryable,
  submitting,
  onRetry,
}: {
  readonly station: StationOf<"bot">;
  readonly stations: ReadonlyArray<Station>;
  readonly owner: BotId;
  readonly retryable: boolean;
  readonly submitting: boolean;
  readonly onRetry?: () => void;
}) {
  const ctx = usePresentation();
  const help = failureHelp(station, stations, owner, ctx);
  if (help.length === 0) return null;
  return (
    <div className="arrive mt-1.5 flex flex-col items-start gap-1.5">
      {help.map((line) => (
        <p key={line} className="text-2xs text-muted-foreground">
          {line}
        </p>
      ))}
      {retryable && onRetry !== undefined && (
        <Button
          variant="primary"
          size="sm"
          className="mt-1"
          aria-disabled={submitting}
          onClick={() => {
            if (!submitting) onRetry();
          }}
        >
          {ctx.i18n.t("routine.failed.tryAgain")}
        </Button>
      )}
    </div>
  );
}

/**
 * A finished run, folded into one quiet line, "Monday emails, done in 6m",
 * which opens the whole rail with each step's result. `folding` when it ended
 * on screen: the line pops in.
 */
function TrackFold({
  name,
  trigger,
  owner,
  steps,
  run,
  folding,
}: RoutineTrackProps & { readonly run: RoutineRun; readonly folding: boolean }) {
  const ctx = usePresentation();
  const stations = trackStations(steps, run);
  return (
    <Collapsible.Root className="mt-3 self-start">
      <Collapsible.Trigger
        className={cn(
          "pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
          touchTarget,
          folding && "arrive-pop origin-left",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90"
        />
        <span>{foldLine(name, run, stations, ctx)}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
        <div className="mt-1.5 max-w-(--layout-card-width) ps-2">
          <Rail name={name} trigger={trigger} owner={owner} stations={stations} retryable={false} />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Quick access's view of a run: a window of its rail around where it is,
 * with the steps before and after counted, and the yes it waits for.
 */
export function RoutineTrackWindow({
  name,
  trigger,
  owner,
  steps,
  run,
  submitting = false,
  onAnswer,
  onRetry,
}: Pick<
  RoutineTrackProps,
  "name" | "trigger" | "owner" | "steps" | "submitting" | "onAnswer" | "onRetry"
> & { readonly run: RoutineRun }) {
  return (
    <Rail
      name={name}
      trigger={trigger}
      owner={owner}
      stations={trackStations(steps, run)}
      retryable={run.retryable === true}
      submitting={submitting}
      windowed
      {...(onAnswer === undefined ? {} : { onAnswer })}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

/** A routine with several steps at rest: its rail alone, for its runs dialog. */
export function RoutineTrackRest({
  name,
  trigger,
  owner,
  steps,
}: Pick<RoutineTrackProps, "name" | "trigger" | "owner" | "steps">) {
  return (
    <Rail
      name={name}
      trigger={trigger}
      owner={owner}
      stations={trackStations(steps, null)}
      retryable={false}
    />
  );
}

/** The space between two marks of a mini rail, in px. */
const MINI_STEP = 16;

/**
 * A run in small, for its row in the routine's runs: a dot in each bot's
 * color and an amber one for the operator's yes, joined by a line that ends
 * where the run ended; a hollow ring for a step not reached, a diamond for a
 * condition, with its siding and bar where it stopped the run, and a red
 * ring where a step failed.
 */
export function MiniRail({ run }: { readonly run: RoutineRun }) {
  const bots = useBots();
  const marks = miniRail(run);
  const ends = marks.findIndex(
    (mark) =>
      (mark._tag === "condition" && mark.stopped) ||
      (mark._tag !== "condition" && mark.mark === "failed"),
  );
  const lastReached = marks.reduce(
    (last, mark, at) => (mark._tag === "condition" || mark.mark !== "open" ? at : last),
    0,
  );
  const lineTo = ends === -1 ? lastReached : ends;
  const x = (at: number) => 5 + at * MINI_STEP;
  const stopped = marks.findIndex((mark) => mark._tag === "condition" && mark.stopped);
  return (
    <svg
      aria-hidden
      width={x(marks.length - 1) + 5}
      height={stopped === -1 ? 10 : 20}
      className="shrink-0 overflow-visible"
    >
      {lineTo > 0 && (
        <line
          x1={x(0)}
          x2={x(lineTo)}
          y1={5}
          y2={5}
          strokeWidth={2}
          className="stroke-muted-foreground/50"
        />
      )}
      {stopped !== -1 && (
        <g className="stroke-muted-foreground" fill="none" strokeWidth={1.5}>
          <path
            d={`M ${x(stopped)} 9 Q ${x(stopped)} 15 ${x(stopped) + 6} 15 L ${x(stopped) + 11} 15`}
          />
          <line x1={x(stopped) + 12.5} x2={x(stopped) + 12.5} y1={12} y2={18} />
        </g>
      )}
      {marks.map((mark) => {
        const cx = x(mark.index);
        switch (mark._tag) {
          case "condition":
            return (
              <rect
                key={mark.index}
                x={cx - 3}
                y={2}
                width={6}
                height={6}
                transform={`rotate(45 ${cx} 5)`}
                strokeWidth={1.5}
                className={cn(
                  "stroke-muted-foreground",
                  mark.stopped ? "fill-muted-foreground" : "fill-surface",
                )}
              />
            );
          case "you":
          case "bot": {
            const color = mark._tag === "you" ? "var(--waiting)" : botInk(mark.botId, bots);
            return mark.mark === "done" ? (
              <circle key={mark.index} cx={cx} cy={5} r={5} style={{ fill: color }} />
            ) : (
              <circle
                key={mark.index}
                cx={cx}
                cy={5}
                r={4.25}
                strokeWidth={1.5}
                className={
                  mark.mark === "failed"
                    ? "fill-surface stroke-blocked"
                    : "fill-surface stroke-input"
                }
              />
            );
          }
        }
      })}
    </svg>
  );
}
