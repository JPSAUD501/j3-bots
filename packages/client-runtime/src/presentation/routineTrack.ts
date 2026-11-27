// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Track (decision 0080): a routine with several steps drawn as a rail of
 * stations, its trigger first, then each step, in a run with where each one
 * stands. Everything here comes from the routine's structured steps and the
 * run the server sent, never from free text, so the card says what runs.
 */
import type {
  BotId,
  RoutineAnswer,
  RoutineAsk,
  RoutineRun,
  RoutineRunStep,
  RoutineStep,
  RoutineStepFailure,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";

/** A bot step's station. `rest` is a routine drawn with no run. */
export type BotStationState = "rest" | "todo" | "doing" | "done" | "failed" | "skipped";

/** A condition's station. */
export type ConditionStationState = "rest" | "todo" | "passed" | "stopped" | "skipped";

/** The operator's stop for a yes. */
export type YouStationState =
  | "rest"
  | "todo"
  | "waiting"
  | "yes"
  | "no"
  | "timed-out"
  | "not-needed"
  | "skipped"
  | "failed";

export type Station =
  | { readonly _tag: "trigger" }
  | {
      readonly _tag: "bot";
      /** The step's place in the routine. */
      readonly index: number;
      readonly botId: BotId;
      readonly action: string;
      readonly state: BotStationState;
      /** Done: its line of result; failed blocked: what stopped it. */
      readonly result: string | null;
      readonly failure: RoutineStepFailure | null;
      /** Failed once its turn had started: it may have done part of its work. */
      readonly partial: boolean;
      /** Waiting to be tried again by itself, after an attempt that never started. */
      readonly retryAt: DateTime.Utc | null;
    }
  | {
      readonly _tag: "condition";
      readonly index: number;
      readonly check: string;
      readonly state: ConditionStationState;
      /** Judged: the line of the step before it was judged on. */
      readonly result: string | null;
    }
  | {
      readonly _tag: "you";
      readonly index: number;
      readonly onlyIf: string | null;
      readonly state: YouStationState;
      readonly ask: RoutineAsk | null;
      readonly answer: RoutineAnswer | null;
    };

export type StationOf<T extends Station["_tag"]> = Extract<Station, { readonly _tag: T }>;

/** A station's place on the rail, as a list's key: the trigger, or its step's place. */
export const stationKey = (station: Station): string =>
  station._tag === "trigger" ? "trigger" : `step-${station.index}`;

const botState = (run: RoutineRunStep): BotStationState => {
  switch (run.state) {
    case "doing":
    case "done":
    case "failed":
    case "skipped":
    case "todo":
      return run.state;
    default:
      return "todo";
  }
};

const conditionState = (run: RoutineRunStep): ConditionStationState => {
  switch (run.state) {
    case "passed":
    case "stopped":
    case "skipped":
    case "todo":
      return run.state;
    default:
      return "todo";
  }
};

const youState = (run: RoutineRunStep): YouStationState => {
  switch (run.state) {
    case "waiting":
    case "yes":
    case "no":
    case "timed-out":
    case "not-needed":
    case "skipped":
    case "failed":
    case "todo":
      return run.state;
    default:
      return "todo";
  }
};

/** One step's station, at rest when `run` is undefined. */
function stationOf(step: RoutineStep, index: number, run: RoutineRunStep | undefined): Station {
  switch (step._tag) {
    case "bot":
      return {
        _tag: "bot",
        index,
        botId: step.botId,
        action: step.action,
        state: run === undefined ? "rest" : botState(run),
        result: run?.result ?? null,
        failure: run?.failure ?? null,
        partial: run?.partial === true,
        retryAt: run?.retryAt ?? null,
      };
    case "condition":
      return {
        _tag: "condition",
        index,
        check: step.check,
        state: run === undefined ? "rest" : conditionState(run),
        result: run?.result ?? null,
      };
    case "yes":
      return {
        _tag: "you",
        index,
        onlyIf: step.onlyIf,
        state: run === undefined ? "rest" : youState(run),
        ask: run?.ask ?? null,
        answer: run?.answer ?? null,
      };
  }
}

/**
 * The rail's stations: the trigger, then each step. With `run`, each step as
 * the run copied it, where it stands; without, the routine's steps at rest.
 */
export function trackStations(
  steps: ReadonlyArray<RoutineStep>,
  run: RoutineRun | null,
): ReadonlyArray<Station> {
  const trigger: Station = { _tag: "trigger" };
  if (run?.steps === undefined) {
    return [trigger, ...steps.map((step, index) => stationOf(step, index, undefined))];
  }
  return [trigger, ...run.steps.map((step, index) => stationOf(step.step, index, step))];
}

/** The steps a run follows: those it copied when it started, else the routine's. */
export const runSteps = (
  steps: ReadonlyArray<RoutineStep>,
  run: RoutineRun | null,
): ReadonlyArray<RoutineStep> => run?.steps?.map((step) => step.step) ?? steps;

/** Where a run of the Track stands, as its card's tag says it. */
export type TrackStatus =
  /** A routine just made, drawn at rest. */
  | "new"
  | "running"
  /** It waits for the operator's yes. */
  | "waiting"
  /** It failed at a step the operator can see to. */
  | "needs-you"
  /** The operator stopped it. */
  | "stopped"
  /** Every step ran. */
  | "done"
  /** A condition did not hold, a yes was a no or went unanswered: it ended there, quietly. */
  | "stopped-quietly";

export function trackStatus(run: RoutineRun | null): TrackStatus {
  if (run === null) return "new";
  const steps = run.steps ?? [];
  switch (run.status) {
    case "running":
      return steps.some((step) => step.state === "waiting") ? "waiting" : "running";
    case "failed":
      return steps.some((step) => step.failure === "stopped") ? "stopped" : "needs-you";
    case "delivered":
    case "silent":
    case "skipped":
      return steps.some(
        (step) => step.state === "stopped" || step.state === "no" || step.state === "timed-out",
      )
        ? "stopped-quietly"
        : "done";
  }
}

/** Whether the card asks for the operator: a yes is open, or a failure is theirs to see to. */
export const trackAttention = (status: TrackStatus): "waiting" | "blocked" | null =>
  status === "waiting" ? "waiting" : status === "needs-you" ? "blocked" : null;

/** The bots that do the routine's steps, each once, in the order they first act. */
export function trackCast(steps: ReadonlyArray<RoutineStep>): ReadonlyArray<BotId> {
  const cast: Array<BotId> = [];
  for (const step of steps) {
    if (step._tag === "bot" && !cast.includes(step.botId)) cast.push(step.botId);
  }
  return cast;
}

/** Whether the routine stops for the operator's yes. */
export const asksYou = (steps: ReadonlyArray<RoutineStep>): boolean =>
  steps.some((step) => step._tag === "yes");

/**
 * The station the run is at: the step being done, the yes it waits for, or
 * the one it failed or stopped at. Null for a routine at rest or a run that
 * ran to its end.
 */
export function currentStation(stations: ReadonlyArray<Station>): number | null {
  const at = stations.findIndex(
    (station) =>
      station._tag !== "trigger" &&
      (station.state === "doing" ||
        station.state === "waiting" ||
        station.state === "failed" ||
        station.state === "stopped"),
  );
  return at === -1 ? null : at;
}

/**
 * How far the line is ink, as the station it reaches: every station up to
 * the current one; all of them for a run that ran to its end; none at rest.
 * A run that ended quietly is ink up to where it stopped.
 */
export function inkTo(stations: ReadonlyArray<Station>): number {
  const current = currentStation(stations);
  if (current !== null) return current;
  let last = 0;
  for (const [at, station] of stations.entries()) {
    if (station._tag === "trigger") continue;
    if (station.state !== "rest" && station.state !== "todo" && station.state !== "skipped") {
      last = at;
    }
  }
  return last;
}

/** What quick access shows of a long rail: a window around where the run is. */
export interface TrackWindow {
  /** Steps before the ones shown, all done. */
  readonly before: number;
  /** The stations shown, from `from`. */
  readonly from: number;
  readonly to: number;
  /** Steps after the ones shown. */
  readonly after: number;
}

/**
 * The window quick access shows: the station the run is at with the one
 * before and the one after, the trigger left out; the rest counted.
 */
export function trackWindow(stations: ReadonlyArray<Station>): TrackWindow {
  const current = currentStation(stations) ?? stations.length - 1;
  const from = Math.max(1, current - 1);
  const to = Math.min(stations.length - 1, current + 1);
  return { before: from - 1, from, to, after: stations.length - 1 - to };
}

/** One mark of a run's mini rail. */
export type MiniMark = { readonly index: number } & (
  | { readonly _tag: "bot"; readonly botId: BotId; readonly mark: "done" | "open" | "failed" }
  | { readonly _tag: "you"; readonly mark: "done" | "open" | "failed" }
  | { readonly _tag: "condition"; readonly stopped: boolean }
);

/**
 * A run in small, for its row in the routine's runs: a dot per bot step and
 * for the operator's yes, a diamond per condition. A step not reached is a
 * hollow ring; a condition that stopped it draws its siding; where it failed
 * is a red ring. The line ends where the run ended.
 */
export function miniRail(run: RoutineRun): ReadonlyArray<MiniMark> {
  return (run.steps ?? []).map((step, index): MiniMark => {
    const mark = (): "done" | "open" | "failed" =>
      step.state === "failed"
        ? "failed"
        : step.state === "todo" ||
            step.state === "skipped" ||
            step.state === "not-needed" ||
            step.state === "doing" ||
            step.state === "waiting"
          ? "open"
          : "done";
    switch (step.step._tag) {
      case "bot":
        return { _tag: "bot", index, botId: step.step.botId, mark: mark() };
      case "condition":
        return { _tag: "condition", index, stopped: step.state === "stopped" };
      case "yes":
        return { _tag: "you", index, mark: step.state === "no" ? "open" : mark() };
    }
  });
}

/** The results a failed run keeps, in order: what the steps done before it reported. */
export const keptResults = (stations: ReadonlyArray<Station>): ReadonlyArray<string> =>
  stations.flatMap((station) =>
    station._tag === "bot" && station.state === "done" && station.result !== null
      ? [station.result]
      : [],
  );
