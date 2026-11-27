// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith, type RoutineCardCommand } from "@j3-bots/client-runtime";
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
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import {
  botStationSub,
  botStationTitle,
  conditionTitle,
  endReason,
  failureHelp,
  foldLine,
  keyedRuns,
  routineSentence,
  scheduleInWords,
  stationStateText,
  trackTag,
  youStationLines,
} from "@j3-bots/client-runtime/wording";
import type {
  BotId,
  RoutineAnswer,
  RoutineChangeEntry,
  RoutineRun,
  RoutineRunEntry,
  RoutineStep,
  RoutineTrigger,
} from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { CalendarClock, Check, ChevronRight, Minus, User, Webhook } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";
import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { SwapText } from "../components/SwapText.tsx";
import { useI18n } from "../i18n.ts";
import { enteringWhen, popIn, settleIn, useReducedMotion, useStep } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { AnimatedView } from "./animated.ts";
import { CardFrame, useSubmitting } from "./CardFrame.tsx";
import { useBotInk, useTrackLit } from "./tint.ts";

/** The mark column, in px: the line runs down its middle. */
const MARK = 28;
const LINE_X = MARK / 2;
/** The text column starts here, in px. */
const TEXT_X = MARK + 12;
/** The gap the line leaves at every mark, in px. */
const GAP = 4;
/** How long a finished run stays drawn whole before it folds into its line, in ms. */
const FOLD_AFTER = 900;

const slide = reanimatedSpring(springs.slide);
const pop = reanimatedSpring(springs.pop);

type Answer = (choice: RoutineAnswer["choice"], note: string | null) => void;

/** What the operator is told when their command on a routine's run did not reach it. */
const routineFailed = {
  answer: "routine.you.answerFailed",
  retry: "routine.failed.retryFailed",
  stop: "routine.track.stopFailed",
} as const satisfies Record<RoutineCardCommand["_tag"], string>;

/**
 * A routine with several steps that a bot made or changed, drawn as its
 * track at rest (decision 0080).
 */
export function RoutineChangeCard({
  entry,
}: {
  readonly entry: RoutineChangeEntry & { readonly steps: ReadonlyArray<RoutineStep> };
}) {
  return (
    <TrackCard
      name={entry.name}
      trigger={entry.trigger}
      owner={entry.author._tag === "bot" ? entry.author.botId : null}
      steps={entry.steps}
      run={null}
      status="new"
      submitting={false}
    />
  );
}

/**
 * A run of a routine with several steps, as the web draws it: the card
 * follows the run, opens the yes inside its stop, says what to do about a
 * failed step with one action, and folds into one line once it ends.
 */
export function RoutineRunCard({ entry }: { readonly entry: RoutineRunEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const submitting = useSubmitting(entry.id);
  const { run } = entry;
  const status = trackStatus(run);
  const ended = status === "done" || status === "stopped-quietly";
  const reduced = useReducedMotion();
  const [endedAtFirst] = useState(ended);
  // Once folded it stays so; a run that ends again folds again after its pause.
  const [folded, setFolded] = useState(ended);
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setFolded(true), reduced ? 0 : FOLD_AFTER);
    return () => clearTimeout(timer);
  }, [ended, reduced]);

  const command = (next: RoutineCardCommand) => {
    if (submitting) return;
    void client.routineCard(entry.id, next).then((result) => {
      // A run that moved on meanwhile closed the card: the card already shows where it is.
      if (result._tag === "done" || refusedWith(result, "card-closed")) return;
      say(t(routineFailed[next._tag], { name: entry.name }));
    });
  };

  if (ended && folded) {
    return (
      <TrackFold
        name={entry.name}
        trigger={entry.trigger}
        owner={entry.author.botId}
        run={run}
        folding={!endedAtFirst}
      />
    );
  }
  return (
    <TrackCard
      name={entry.name}
      trigger={entry.trigger}
      owner={entry.author.botId}
      steps={[]}
      run={run}
      status={status}
      submitting={submitting}
      onAnswer={(choice, note) => command({ _tag: "answer", runId: run.id, choice, note })}
      onRetry={() => command({ _tag: "retry", runId: run.id })}
      onStop={() => command({ _tag: "stop", runId: run.id })}
    />
  );
}

interface TrackCardProps {
  readonly name: string;
  readonly trigger: RoutineTrigger;
  /** The bot whose routine it is, which a failed step names; a run's is always known. */
  readonly owner: BotId | null;
  readonly steps: ReadonlyArray<RoutineStep>;
  readonly run: RoutineRun | null;
  readonly status: TrackStatus;
  readonly submitting: boolean;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
  readonly onStop?: () => void;
}

function TrackCard({
  name,
  trigger,
  owner,
  steps,
  run,
  status,
  submitting,
  onAnswer,
  onRetry,
  onStop,
}: TrackCardProps) {
  const ctx = usePresentation();
  const attention = trackAttention(status);
  const going = status === "running" || status === "waiting";
  return (
    <CardFrame
      icon={trigger._tag === "webhook" ? Webhook : CalendarClock}
      title={name}
      attention={attention === "blocked" ? "blocked" : attention === "waiting"}
      tag={trackTag(status, ctx)}
    >
      <RoutineSentence trigger={trigger} steps={runSteps(steps, run)} className="text-sm" />
      <Rail
        name={name}
        trigger={trigger}
        owner={owner}
        stations={trackStations(steps, run)}
        retryable={run?.retryable === true}
        submitting={submitting}
        {...(onAnswer === undefined ? {} : { onAnswer })}
        {...(onRetry === undefined ? {} : { onRetry })}
      />
      {going && onStop !== undefined && (
        <View className="flex-row justify-end">
          <Button
            label={ctx.i18n.t("routine.track.stop")}
            variant="quiet"
            held={submitting}
            onPress={onStop}
          />
        </View>
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
  className,
  lines,
}: {
  readonly trigger: RoutineTrigger;
  readonly steps: ReadonlyArray<RoutineStep>;
  readonly className: string;
  /** At most this many lines, the rest cut with an ellipsis. */
  readonly lines?: number;
}) {
  const ctx = usePresentation();
  return (
    <Text
      className={`${className} text-muted-foreground`}
      {...(lines === undefined ? {} : { numberOfLines: lines })}
    >
      {keyedRuns(routineSentence(trigger, steps, ctx)).map((run) => (
        <Text
          key={run.key}
          className={
            run.tone === "bot"
              ? "font-medium text-foreground"
              : run.tone === "you"
                ? "font-medium text-waiting"
                : ""
          }
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
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

/** What lights a station's row: its bot at work, the operator's stop, a step that failed. */
const litOf = (station: Station): "bot" | "waiting" | "blocked" | null => {
  if (station._tag === "bot") {
    return station.state === "doing" ? "bot" : station.state === "failed" ? "blocked" : null;
  }
  return station._tag === "you" && station.state === "waiting" ? "waiting" : null;
};

/** A row's padding above its mark, in px: more while lit, less for a condition. */
const padOf = (station: Station): number =>
  litOf(station) !== null ? 8 : station._tag === "condition" ? 5 : 6;

/** Where a row sits in the rail, and where its siding's words sit inside it. */
interface Placed {
  readonly y: number;
  readonly siding: number | null;
}

interface RailProps {
  readonly name: string;
  readonly trigger: RoutineTrigger;
  readonly owner: BotId | null;
  readonly stations: ReadonlyArray<Station>;
  readonly retryable: boolean;
  readonly submitting: boolean;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
}

/**
 * The rail: the stations in a column, and under them one line, laid out from
 * the rows' measured places. Grey ahead, ink behind, a gap at every mark, a
 * condition's siding ending at its bar; the light runs down it from the
 * station the run left to the one it reached.
 */
function Rail({
  name,
  trigger,
  owner,
  stations,
  retryable,
  submitting,
  onAnswer,
  onRetry,
}: RailProps) {
  const ctx = usePresentation();
  const [placed, setPlaced] = useState<ReadonlyMap<number, Placed>>(new Map());
  const [height, setHeight] = useState(0);
  const place = (at: number, change: Partial<Placed>) =>
    setPlaced((current) => {
      const was = current.get(at) ?? { y: 0, siding: null };
      const next = { ...was, ...change };
      if (was.y === next.y && was.siding === next.siding) return current;
      return new Map(current).set(at, next);
    });
  const marks = stations.flatMap((station, at) => {
    const row = placed.get(at);
    return row === undefined
      ? []
      : [{ y: row.y + padOf(station) + MARK / 2, reach: reachOf(station) }];
  });
  const sidings = new Map(
    stations.flatMap((station, at) => {
      const row = placed.get(at);
      return row?.siding == null ? [] : [[at, row.y + padOf(station) + row.siding] as const];
    }),
  );
  const current = currentStation(stations);
  const reason = endReason(stations, ctx);

  return (
    <View
      accessibilityLabel={ctx.i18n.plural("routine.track.label", stations.length - 1, { name })}
      onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height)}
    >
      {height > 0 && marks.length === stations.length && (
        <RailLine
          height={height}
          marks={marks}
          sidings={sidings}
          shown={stations}
          ink={inkTo(stations)}
          current={current}
        />
      )}
      {stations.map((station, at) => (
        <StationRow
          key={stationKey(station)}
          station={station}
          stations={stations}
          trigger={trigger}
          owner={owner}
          reason={reason}
          retryable={retryable}
          submitting={submitting}
          onPlaced={(y) => place(at, { y })}
          onSiding={(y) => place(at, { siding: y })}
          {...(onAnswer === undefined ? {} : { onAnswer })}
          {...(onRetry === undefined ? {} : { onRetry })}
        />
      ))}
    </View>
  );
}

interface Mark {
  readonly y: number;
  readonly reach: number;
}

/** The light's color at a station: its bot's own, the waiting color at the stop, ink at the trigger. */
function useLightColor(station: Station | undefined): string {
  const bots = useBots();
  const bot = station?._tag === "bot" ? bots.get(station.botId) : undefined;
  const ink = useBotInk(bot?.profile.avatar ?? null);
  const waiting = useColor("accent-waiting");
  const foreground = useColor("accent-foreground");
  return station?._tag === "bot" ? ink : station?._tag === "you" ? waiting : foreground;
}

function RailLine({
  height,
  marks,
  sidings,
  shown,
  ink,
  current,
}: {
  readonly height: number;
  readonly marks: ReadonlyArray<Mark>;
  readonly sidings: ReadonlyMap<number, number>;
  readonly shown: ReadonlyArray<Station>;
  readonly ink: number;
  readonly current: number | null;
}) {
  const reduced = useReducedMotion();
  const inked = useColor("accent-muted-foreground");
  const ahead = useColor("accent-input");

  // The light: one leg at a time, from the station the run left to the one it reached.
  const previous = useRef(current);
  const [leg, setLeg] = useState<{ readonly from: number; readonly to: number } | null>(null);
  useEffect(() => {
    const from = previous.current;
    previous.current = current;
    if (from === null || current === null || current <= from || reduced) return;
    setLeg({ from, to: current });
  }, [current, reduced]);
  const a = leg === null ? undefined : marks[leg.from];
  const b = leg === null ? undefined : marks[leg.to];
  const y0 = a === undefined ? 0 : a.y + a.reach + GAP;
  const y1 = b === undefined ? 0 : b.y - b.reach - GAP;
  const p = useSharedValue(0);
  useEffect(() => {
    if (leg === null) return;
    p.set(0);
    p.set(withDelay(120, withSpring(1, slide)));
    const done = setTimeout(() => setLeg(null), 1400);
    return () => clearTimeout(done);
  }, [leg, p]);
  const light = useAnimatedStyle(() => {
    const at = p.get();
    const seen = at > 0.94 ? Math.max(0, (1 - at) / 0.06) : Math.min(1, at / 0.04);
    return {
      opacity: seen,
      transform: [
        { translateX: LINE_X - 7 + (at < 0.2 ? Math.sin((Math.PI * at) / 0.2) * 7 : 0) },
        { translateY: y0 + (y1 - y0) * at - 7 },
        { scale: 0.5 + seen / 2 },
      ],
    };
  });
  const arriving = useAnimatedStyle(() => ({ opacity: p.get() }));
  const fill = useAnimatedStyle(() => ({ height: Math.max(0, (y1 - y0) * p.get()) }));
  const fromColor = useLightColor(leg === null ? undefined : shown[leg.from]);
  const toColor = useLightColor(leg === null ? undefined : shown[leg.to]);

  const stoppedAt = shown.findIndex(
    (station) => station._tag === "condition" && station.state === "stopped",
  );
  const barX = TEXT_X - GAP - 2;
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
  const isInked = (at: number) => at + 1 <= ink && (leg === null || at < leg.from || at >= leg.to);
  const sidingPaths = shown.flatMap((station, at) => {
    if (station._tag !== "condition") return [];
    const mark = marks[at];
    const words = sidings.get(at);
    if (mark === undefined || words === undefined) return [];
    return [
      {
        at,
        words,
        state: station.state,
        d: `M ${LINE_X} ${mark.y + mark.reach + 1} Q ${LINE_X} ${words} ${LINE_X + 12} ${words} L ${barX - 2} ${words}`,
      },
    ];
  });
  return (
    <View pointerEvents="none" className="absolute inset-0">
      <Svg width="100%" height={height}>
        {segments.map((segment) => (
          <Line
            key={segment.at}
            x1={LINE_X}
            x2={LINE_X}
            y1={segment.from}
            y2={segment.to}
            strokeWidth={2}
            strokeLinecap="round"
            stroke={isInked(segment.at) ? inked : ahead}
          />
        ))}
        {sidingPaths.map((siding) => (
          <G key={siding.at} opacity={siding.state === "passed" ? 0.45 : 1}>
            <Path
              d={siding.d}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              stroke={siding.state === "stopped" ? inked : ahead}
            />
            <Rect
              x={barX}
              y={siding.words - 4.5}
              width={2}
              height={9}
              rx={1}
              fill={siding.state === "stopped" ? inked : ahead}
            />
          </G>
        ))}
        {stoppedAt !== -1 && sidings.get(stoppedAt) !== undefined && (
          <Circle cx={barX - 6} cy={sidings.get(stoppedAt) ?? 0} r={4} fill={inked} />
        )}
      </Svg>
      {leg !== null && (
        <>
          <AnimatedView
            style={[
              fill,
              {
                position: "absolute",
                left: LINE_X - 1,
                top: y0,
                width: 2,
                backgroundColor: inked,
                borderRadius: 1,
              },
            ]}
          />
          <AnimatedView
            style={[light, { position: "absolute", left: 0, top: 0, width: 14, height: 14 }]}
          >
            <View
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 7,
                backgroundColor: fromColor,
                opacity: 0.22,
              }}
            />
            <View
              style={{
                position: "absolute",
                left: 3,
                top: 3,
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: fromColor,
              }}
            />
            <AnimatedView style={[arriving, { position: "absolute", inset: 0 }]}>
              <View
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 7,
                  backgroundColor: toColor,
                  opacity: 0.22,
                }}
              />
              <View
                style={{
                  position: "absolute",
                  left: 3,
                  top: 3,
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: toColor,
                }}
              />
            </AnimatedView>
          </AnimatedView>
        </>
      )}
    </View>
  );
}

interface StationRowProps {
  readonly station: Station;
  readonly stations: ReadonlyArray<Station>;
  readonly trigger: RoutineTrigger;
  readonly owner: BotId | null;
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly submitting: boolean;
  readonly onPlaced: (y: number) => void;
  /** Where its siding's words sit below the row's padding, for a condition. */
  readonly onSiding: (y: number) => void;
  readonly onAnswer?: Answer;
  readonly onRetry?: () => void;
}

function StationRow(props: StationRowProps) {
  const { station, onPlaced } = props;
  const ctx = usePresentation();
  const bots = useBots();
  const bot = station._tag === "bot" ? bots.get(station.botId) : undefined;
  const botLit = useTrackLit(bot?.profile.avatar ?? null);
  const waiting = useColor("accent-waiting-surface");
  const blocked = useColor("accent-blocked-surface");
  const lit = litOf(station);
  const wash =
    lit === "bot" ? botLit : lit === "waiting" ? waiting : lit === "blocked" ? blocked : null;
  const stands = stationStateText(station, ctx);
  const faded =
    station._tag !== "trigger" && (station.state === "skipped" || station.state === "not-needed");
  return (
    <View
      onLayout={(event) => onPlaced(event.nativeEvent.layout.y)}
      style={{ paddingVertical: padOf(station), opacity: faded ? 0.5 : 1 }}
      className="flex-row gap-3"
    >
      {wash !== null && (
        <AnimatedView
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: -8,
            right: -8,
            borderRadius: 14,
            backgroundColor: wash,
          }}
        />
      )}
      <View style={{ width: MARK, height: MARK }} className="items-center justify-center">
        <StationMark station={station} trigger={props.trigger} />
      </View>
      <View
        className="min-w-0 flex-1"
        accessible={station._tag !== "you" || station.state !== "waiting"}
        {...(stands === null ? {} : { accessibilityHint: stands })}
      >
        <StationText {...props} />
      </View>
    </View>
  );
}

function StationMark({
  station,
  trigger,
}: {
  readonly station: Station;
  readonly trigger: RoutineTrigger;
}) {
  switch (station._tag) {
    case "trigger":
      return (
        <View className="size-[22px] items-center justify-center rounded-pill bg-muted">
          <Icon
            icon={trigger._tag === "webhook" ? Webhook : CalendarClock}
            size={13}
            color="accent-muted-foreground"
          />
        </View>
      );
    case "bot":
      return <BotFace station={station} />;
    case "condition": {
      const judged = station.state === "passed" || station.state === "stopped";
      return (
        <AnimatedView
          key={judged ? "judged" : "open"}
          {...enteringWhen(judged, popIn())}
          style={{ transform: [{ rotate: "45deg" }] }}
          className={`size-2.5 rounded-[1.5px] border-[1.5px] border-muted-foreground ${judged ? "bg-muted-foreground" : "bg-surface"}`}
        />
      );
    }
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
  const big = station.state === "doing" || station.state === "failed";
  const reduced = useReducedMotion();
  const scale = useSharedValue(big ? 1 : 0.79);
  useEffect(() => {
    const was = previous.current;
    previous.current = station.state;
    const to = station.state === "doing" || station.state === "failed" ? 1 : 0.79;
    scale.set(reduced ? to : withSpring(to, station.state === "doing" ? pop : slide));
    if (was === station.state) return;
    if (station.state === "doing") handle.current?.poke("catch");
    else if (station.state === "done" && was === "doing") handle.current?.poke("smile");
    else if (station.state === "failed") handle.current?.poke("sulk");
  }, [station.state, scale, reduced]);
  const sized = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <AnimatedView style={sized}>
      {bot === undefined ? (
        <View className="size-[22px] rounded-pill bg-muted" />
      ) : (
        <BotAvatar
          ref={handle}
          avatar={bot.profile.avatar}
          seed={bot.id}
          state={faceState(station)}
          size={MARK}
        />
      )}
      {station.state === "done" && <CheckBadge fresh={!doneAtFirst} icon="check" />}
    </AnimatedView>
  );
}

/** The plan's check at a face's lower right: a check for a step done, a minus for a no. */
function CheckBadge({
  fresh,
  icon,
}: {
  readonly fresh: boolean;
  readonly icon: "check" | "minus";
}) {
  return (
    <AnimatedView
      {...enteringWhen(fresh, popIn())}
      className="absolute -end-1 -bottom-[3px] size-3.5 items-center justify-center rounded-pill border-2 border-surface bg-muted"
    >
      <Icon icon={icon === "check" ? Check : Minus} size={8} color="accent-foreground" />
    </AnimatedView>
  );
}

/** The operator's stop: an amber ring at rest, filled with its ping while it waits for them. */
function YouMark({ station }: { readonly station: StationOf<"you"> }) {
  const waiting = station.state === "waiting";
  const reduced = useReducedMotion();
  // The ping, stepped in 12 like the avatar's; a still ring under reduced motion.
  const step = useStep(1600, 12, waiting && !reduced);
  const ping = step / 12;
  const timedOut = station.state === "timed-out";
  return (
    <View>
      {waiting && (
        <View
          style={{
            position: "absolute",
            inset: reduced ? -3 : 0,
            borderRadius: 11,
            borderWidth: 1.5,
            opacity: reduced ? 0.4 : 0.7 * (1 - ping),
            transform: [{ scale: reduced ? 1 : 1 + 0.7 * ping }],
          }}
          className="border-waiting"
        />
      )}
      <View
        className={`size-[22px] items-center justify-center rounded-pill ${timedOut ? "bg-muted" : waiting ? "bg-waiting" : "border-[1.5px] border-waiting bg-waiting-surface"}`}
      >
        <Icon
          icon={User}
          size={13}
          color={
            timedOut ? "accent-muted-foreground" : waiting ? "accent-surface" : "accent-waiting"
          }
        />
      </View>
      {(station.state === "yes" || station.state === "no") && (
        <CheckBadge fresh icon={station.state === "yes" ? "check" : "minus"} />
      )}
    </View>
  );
}

function StationText({
  station,
  stations,
  trigger,
  owner,
  reason,
  retryable,
  submitting,
  onSiding,
  onAnswer,
  onRetry,
}: StationRowProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const lit = litOf(station) !== null;
  const titleClass = `pt-1 text-sm ${lit || (station._tag !== "trigger" && station.state === "rest") || station._tag === "trigger" ? "text-foreground" : "text-muted-foreground"} ${lit ? "font-medium" : ""}`;
  switch (station._tag) {
    case "trigger":
      return <Text className={titleClass}>{scheduleInWords(trigger, ctx)}</Text>;
    case "bot": {
      const sub = botStationSub(station, reason, ctx);
      return (
        <>
          <Text className={titleClass}>{botStationTitle(station, ctx)}</Text>
          {sub !== null && (
            <SwapText
              text={sub}
              className={`text-2xs ${station.state === "failed" ? "text-foreground" : "text-muted-foreground"}`}
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
          <SwapText
            text={conditionTitle(station, ctx)}
            className="pt-1.5 text-xs text-muted-foreground"
          />
          <View
            onLayout={(event) =>
              onSiding(event.nativeEvent.layout.y + event.nativeEvent.layout.height / 2)
            }
          >
            <Text
              className={`text-2xs ${station.state === "stopped" ? "text-foreground" : "text-muted-foreground"}`}
              style={{ opacity: station.state === "passed" ? 0.45 : 1 }}
            >
              {t("routine.gate.otherwise")}
            </Text>
          </View>
        </>
      );
    case "you": {
      const lines = youStationLines(station, reason, ctx);
      return (
        <>
          <Text className={titleClass}>{lines.title}</Text>
          {lines.sub !== null && (
            <Text className="text-2xs text-muted-foreground">{lines.sub}</Text>
          )}
          {station.state === "waiting" && station.ask !== null && onAnswer !== undefined && (
            <YesAsk
              yes={station.ask.yes}
              no={station.ask.no}
              submitting={submitting}
              onAnswer={onAnswer}
            />
          )}
        </>
      );
    }
  }
}

/** What the yes asks, opened inside its stop: its two choices and a note. */
function YesAsk({
  yes,
  no,
  submitting,
  onAnswer,
}: {
  readonly yes: string;
  readonly no: string;
  readonly submitting: boolean;
  readonly onAnswer: Answer;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const answer = (choice: RoutineAnswer["choice"]) => {
    const kept = note.trim();
    onAnswer(choice, kept === "" ? null : kept);
  };
  return (
    <AnimatedView entering={settleIn(springs.soft)} className="mt-2 gap-2">
      <TextInput
        value={note}
        onChangeText={setNote}
        multiline
        placeholder={t("question.addNote")}
        accessibilityLabel={t("question.addNote")}
        className="min-h-11 rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button label={yes} variant="primary" held={submitting} onPress={() => answer("yes")} />
        <Button label={no} variant="outline" held={submitting} onPress={() => answer("no")} />
      </View>
    </AnimatedView>
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
    <AnimatedView entering={settleIn(springs.soft)} className="mt-1.5 items-start gap-1.5">
      {help.map((line) => (
        <Text key={line} className="text-2xs text-muted-foreground">
          {line}
        </Text>
      ))}
      {retryable && onRetry !== undefined && (
        <Button
          label={ctx.i18n.t("routine.failed.tryAgain")}
          variant="primary"
          held={submitting}
          onPress={onRetry}
        />
      )}
    </AnimatedView>
  );
}

/**
 * A finished run, folded into one quiet line, which opens the whole rail
 * with each step's result. `folding` when it ended on screen: the line
 * settles in.
 */
function TrackFold({
  name,
  trigger,
  owner,
  run,
  folding,
}: {
  readonly name: string;
  readonly trigger: RoutineTrigger;
  readonly owner: BotId;
  readonly run: RoutineRun;
  readonly folding: boolean;
}) {
  const ctx = usePresentation();
  const [open, setOpen] = useState(false);
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.set(withSpring(open ? 1 : 0, pop));
  }, [open, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
  const stations = trackStations([], run);
  return (
    <AnimatedView {...enteringWhen(folding, settleIn(springs.pop))} className="mt-2 px-4">
      <PressScale
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        frame={{ alignSelf: "flex-start", marginStart: -8 }}
        className="min-h-11 flex-row items-center gap-1.5 rounded-md px-2"
      >
        <AnimatedView style={chevron}>
          <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
        </AnimatedView>
        <Text className="text-xs text-muted-foreground">{foldLine(name, run, stations, ctx)}</Text>
      </PressScale>
      {open && (
        <AnimatedView
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          className="ps-2"
        >
          <Rail
            name={name}
            trigger={trigger}
            owner={owner}
            stations={stations}
            retryable={false}
            submitting={false}
          />
        </AnimatedView>
      )}
    </AnimatedView>
  );
}

/** A routine with several steps at rest: its rail alone, for its runs screen. */
export function RoutineTrackRest({
  name,
  trigger,
  owner,
  steps,
}: {
  readonly name: string;
  readonly trigger: RoutineTrigger;
  readonly owner: BotId;
  readonly steps: ReadonlyArray<RoutineStep>;
}) {
  return (
    <Rail
      name={name}
      trigger={trigger}
      owner={owner}
      stations={trackStations(steps, null)}
      retryable={false}
      submitting={false}
    />
  );
}

/** The space between two marks of a mini rail, in px. */
const MINI_STEP = 16;

/** One dot of a mini rail, in its bot's color. */
function MiniDot({
  botId,
  x,
  mark,
}: {
  readonly botId: BotId;
  readonly x: number;
  readonly mark: "done" | "open" | "failed";
}) {
  const bot = useBots().get(botId);
  const ink = useBotInk(bot?.profile.avatar ?? null);
  return <MiniCircle x={x} mark={mark} color={ink} />;
}

function MiniCircle({
  x,
  mark,
  color,
}: {
  readonly x: number;
  readonly mark: "done" | "open" | "failed";
  readonly color: string;
}) {
  const surface = useColor("accent-surface");
  const input = useColor("accent-input");
  const blocked = useColor("accent-blocked");
  return mark === "done" ? (
    <Circle cx={x} cy={5} r={5} fill={color} />
  ) : (
    <Circle
      cx={x}
      cy={5}
      r={4.25}
      strokeWidth={1.5}
      fill={surface}
      stroke={mark === "failed" ? blocked : input}
    />
  );
}

/**
 * A run in small, for its row in the routine's runs, as on the web: a dot
 * in each bot's color and an amber one for the operator's yes, joined by a
 * line that ends where the run ended; a hollow ring for a step not reached,
 * a diamond for a condition, with its siding and bar where it stopped the
 * run, and a red ring where a step failed.
 */
export function MiniRail({ run }: { readonly run: RoutineRun }) {
  const marks = miniRail(run);
  const muted = useColor("accent-muted-foreground");
  const surface = useColor("accent-surface");
  const waiting = useColor("accent-waiting");
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
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={x(marks.length - 1) + 5} height={stopped === -1 ? 10 : 20}>
        {lineTo > 0 && (
          <Line
            x1={x(0)}
            x2={x(lineTo)}
            y1={5}
            y2={5}
            strokeWidth={2}
            stroke={muted}
            opacity={0.5}
          />
        )}
        {stopped !== -1 && (
          <>
            <Path
              d={`M ${x(stopped)} 9 Q ${x(stopped)} 15 ${x(stopped) + 6} 15 L ${x(stopped) + 11} 15`}
              fill="none"
              strokeWidth={1.5}
              stroke={muted}
            />
            <Line
              x1={x(stopped) + 12.5}
              x2={x(stopped) + 12.5}
              y1={12}
              y2={18}
              strokeWidth={1.5}
              stroke={muted}
            />
          </>
        )}
        {marks.map((mark) => {
          const cx = x(mark.index);
          switch (mark._tag) {
            case "condition":
              return (
                <Rect
                  key={mark.index}
                  x={cx - 3}
                  y={2}
                  width={6}
                  height={6}
                  transform={`rotate(45 ${cx} 5)`}
                  strokeWidth={1.5}
                  stroke={muted}
                  fill={mark.stopped ? muted : surface}
                />
              );
            case "you":
              return <MiniCircle key={mark.index} x={cx} mark={mark.mark} color={waiting} />;
            case "bot":
              return <MiniDot key={mark.index} x={cx} botId={mark.botId} mark={mark.mark} />;
          }
        })}
      </Svg>
    </View>
  );
}
