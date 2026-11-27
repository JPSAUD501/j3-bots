// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A routine with several steps and its runs at every moment the Track draws
 * (decision 0080): at rest, at work, at the operator's yes, answered, done,
 * stopped at a condition, failed and stopped. Development only.
 */
import type { RoutineCardCommand } from "@j3-bots/client-runtime";
import {
  type BotId,
  EntryId,
  RoutineId,
  RoutineRunId,
  type Routine,
  type RoutineRun,
  type RoutineRunStep,
  type RoutineStep,
  type RoutineTrigger,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { ids, SAMPLE_NOW } from "./sample";

const at = (minutesAgo: number) => DateTime.subtract(SAMPLE_NOW, { minutes: minutesAgo });

const trackRoutineId = RoutineId.make("inbox-replies");
export const trackOwner: BotId = ids.scout;
export const trackName = "Inbox replies";
export const trackTrigger: RoutineTrigger = {
  _tag: "schedule",
  cron: "0 9 * * 1",
  timeZone: "America/Sao_Paulo",
};

const bot = (botId: BotId, action: string): RoutineStep => ({
  _tag: "bot",
  botId,
  action,
  instruction: `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}.`,
});

/** Scout gathers, a condition, Atlas drafts, the operator's yes, Wren sends. */
export const trackSteps: ReadonlyArray<RoutineStep> = [
  bot(ids.scout, "gathers last week's emails"),
  { _tag: "condition", check: "there's something new" },
  bot(ids.atlas, "summarises them and drafts replies"),
  { _tag: "yes", onlyIf: "something needs a reply", waitHours: 24 },
  bot(ids.wren, "sends the replies"),
];

const ask = {
  question: "Send the 3 replies Atlas drafted?",
  yes: "Send them",
  no: "Don't send",
  deadline: DateTime.add(SAMPLE_NOW, { hours: 23 }),
};

type StepPatch = Pick<RoutineRunStep, "state"> & Partial<RoutineRunStep>;

/** A run of the routine started six minutes ago, its steps standing as `patches` say. */
function trackRun(
  status: RoutineRun["status"],
  patches: ReadonlyArray<StepPatch>,
  change: Partial<RoutineRun> = {},
): RoutineRun {
  return {
    id: RoutineRunId.make("gallery-track-run"),
    startedAt: at(6),
    finishedAt: status === "running" ? null : SAMPLE_NOW,
    status,
    attempts: 1,
    delivered: status === "delivered" ? [EntryId.make("gallery-track-said")] : [],
    note: null,
    steps: trackSteps.map((step, index) => ({
      step,
      result: null,
      startedAt: null,
      finishedAt: null,
      ...(patches[index] ?? { state: "todo" }),
    })),
    ...change,
  };
}

const gathered: StepPatch = { state: "done", result: "14 new emails" };
const passed: StepPatch = { state: "passed", result: "14 new emails" };
const drafted: StepPatch = { state: "done", result: "3 replies drafted" };

/** The run at each of its moments, in the order a run goes through them. */
export const trackMoments = {
  gathering: trackRun("running", [{ state: "doing" }]),
  drafting: trackRun("running", [gathered, passed, { state: "doing" }]),
  waiting: trackRun("running", [gathered, passed, drafted, { state: "waiting", ask }]),
  sending: trackRun("running", [
    gathered,
    passed,
    drafted,
    { state: "yes", ask, answer: { choice: "yes", note: null, at: at(1) } },
    { state: "doing" },
  ]),
  done: trackRun("delivered", [
    gathered,
    passed,
    drafted,
    { state: "yes", ask, answer: { choice: "yes", note: null, at: at(2) } },
    { state: "done", result: "3 replies sent" },
  ]),
  nothingNew: trackRun("silent", [
    { state: "done", result: "Nothing new" },
    { state: "stopped", result: "Nothing new" },
    { state: "skipped" },
    { state: "skipped" },
    { state: "skipped" },
  ]),
  saidNo: trackRun("silent", [
    gathered,
    passed,
    drafted,
    { state: "no", ask, answer: { choice: "no", note: null, at: at(1) } },
    { state: "skipped" },
  ]),
  timedOut: trackRun("silent", [
    gathered,
    passed,
    drafted,
    { state: "timed-out", ask: { ...ask, deadline: at(1) } },
    { state: "skipped" },
  ]),
  notNeeded: trackRun("delivered", [
    gathered,
    passed,
    { state: "done", result: "Nothing needed a reply" },
    { state: "not-needed" },
    { state: "done", result: "Nothing to send" },
  ]),
  failed: trackRun(
    "failed",
    [
      gathered,
      passed,
      { state: "failed", failure: "unreported", partial: true },
      { state: "skipped" },
      { state: "skipped" },
    ],
    { retryable: true },
  ),
  blocked: trackRun(
    "failed",
    [
      gathered,
      passed,
      {
        state: "failed",
        failure: "blocked",
        result: "Mail asked to sign in again before it shows the drafts folder.",
      },
      { state: "skipped" },
      { state: "skipped" },
    ],
    { retryable: true },
  ),
  retrying: trackRun("running", [
    gathered,
    passed,
    { state: "doing", retryAt: DateTime.add(SAMPLE_NOW, { minutes: 5 }) },
  ]),
  stopped: trackRun("failed", [
    gathered,
    passed,
    drafted,
    { state: "failed", failure: "stopped", ask },
    { state: "skipped" },
  ]),
} as const satisfies Record<string, RoutineRun>;

/** The moments a played run goes through, one after another. */
export const playedTrack: ReadonlyArray<RoutineRun> = [
  trackMoments.gathering,
  trackRun("running", [gathered, { state: "todo" }]),
  trackMoments.drafting,
  trackMoments.waiting,
];

/** The routine as Scout's routines list it: several steps, its last run waiting for a yes. */
export const trackRoutine: Routine = {
  id: trackRoutineId,
  botId: trackOwner,
  name: trackName,
  instruction: "Gather last week's emails.",
  steps: trackSteps,
  trigger: trackTrigger,
  enabled: true,
  webhookUrl: null,
  nextRunAt: DateTime.add(SAMPLE_NOW, { minutes: 3 * 24 * 60 - 520 }),
  lastRun: trackMoments.waiting,
  runCount: 7,
};

/** The routine's recent runs, newest first, as its runs dialog lists them. */
export const trackRuns: ReadonlyArray<RoutineRun> = [
  trackMoments.waiting,
  { ...trackMoments.done, id: RoutineRunId.make("gallery-track-1"), startedAt: at(7 * 24 * 60) },
  {
    ...trackMoments.nothingNew,
    id: RoutineRunId.make("gallery-track-2"),
    startedAt: at(14 * 24 * 60),
  },
  { ...trackMoments.failed, id: RoutineRunId.make("gallery-track-3"), startedAt: at(21 * 24 * 60) },
  { ...trackMoments.saidNo, id: RoutineRunId.make("gallery-track-4"), startedAt: at(28 * 24 * 60) },
];

/**
 * What the server would do with the operator's command on a run, done by
 * hand for the sample: a yes or no moves past the stop, Try again goes back
 * to work, Stop ends it at the step it is at.
 */
export function sampleTrackCommand(run: RoutineRun, command: RoutineCardCommand): RoutineRun {
  const steps = run.steps ?? [];
  const at = steps.findIndex(
    (step) => step.state === "waiting" || step.state === "doing" || step.state === "failed",
  );
  const here = steps[at];
  if (here === undefined) return run;
  const set = (patch: Partial<RoutineRunStep>, rest: RoutineRunStep["state"], then?: StepPatch) =>
    steps.map((step, index) =>
      index === at
        ? { ...step, ...patch }
        : index === at + 1 && then !== undefined
          ? { ...step, ...then }
          : index > at
            ? { ...step, state: rest }
            : step,
    );
  switch (command._tag) {
    case "answer":
      return command.choice === "yes"
        ? {
            ...run,
            steps: set(
              { state: "yes", answer: { choice: "yes", note: command.note, at: SAMPLE_NOW } },
              "todo",
              { state: "doing" },
            ),
          }
        : {
            ...run,
            status: "silent",
            finishedAt: SAMPLE_NOW,
            steps: set(
              { state: "no", answer: { choice: "no", note: command.note, at: SAMPLE_NOW } },
              "skipped",
            ),
          };
    case "retry":
      return {
        ...run,
        status: "running",
        finishedAt: null,
        retryable: false,
        steps: set({ state: "doing", result: null, partial: false }, "todo"),
      };
    case "stop":
      return {
        ...run,
        status: "failed",
        finishedAt: SAMPLE_NOW,
        steps: set({ state: "failed", failure: "stopped" }, "skipped"),
      };
  }
}
