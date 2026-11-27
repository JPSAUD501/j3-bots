// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import {
  BotId,
  EntryId,
  Label,
  NonNegativeInt,
  PositiveInt,
  RoutineId,
  RoutineRunId,
} from "./base.ts";
import { PermissionMode } from "./bot.ts";

export const RoutineTrigger = Schema.Union([
  /** A five-field cron expression, evaluated in `timeZone` (an IANA name). */
  Schema.TaggedStruct("schedule", { cron: Label, timeZone: Label }),
  /** One run at `at`. The routine pauses itself once that run has started. */
  Schema.TaggedStruct("once", { at: Schema.DateTimeUtc }),
  /** An HTTP endpoint on the J3 Bots server. */
  Schema.TaggedStruct("webhook", {}),
]);
export type RoutineTrigger = typeof RoutineTrigger.Type;

export const RoutineInstruction = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10_000),
);

/** A short phrase a bot writes for a step, in the operator's language: "gathers last week's emails". */
export const StepPhrase = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));

/** The most bot steps a routine has. */
export const MAX_BOT_STEPS = 6;

/** The longest a yes waits, in hours: a week. */
export const MAX_YES_HOURS = 168;

/**
 * A step one bot does (decision 0080): `action` is what it does, after its
 * name ("gathers last week's emails"), and `instruction` the brief its turn
 * starts from.
 */
export const RoutineBotStep = Schema.TaggedStruct("bot", {
  botId: BotId,
  action: StepPhrase,
  instruction: RoutineInstruction,
});
export type RoutineBotStep = typeof RoutineBotStep.Type;

/**
 * What must hold for the routine to go on: `check`, as "there's something
 * new". The bot of the step before says whether it holds; if not, the run
 * stops there, quietly.
 */
export const RoutineCondition = Schema.TaggedStruct("condition", { check: StepPhrase });
export type RoutineCondition = typeof RoutineCondition.Type;

/**
 * The run waits for the operator's yes before it goes on, at most
 * `waitHours`. With `onlyIf`, it asks only when that holds, which the bot of
 * the step before judges ("something needs a reply").
 */
export const RoutineYes = Schema.TaggedStruct("yes", {
  onlyIf: Schema.NullOr(StepPhrase),
  waitHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_YES_HOURS })),
});
export type RoutineYes = typeof RoutineYes.Type;

export const RoutineStep = Schema.Union([RoutineBotStep, RoutineCondition, RoutineYes]);
export type RoutineStep = typeof RoutineStep.Type;

/**
 * Why a list of steps cannot be a routine's, in words for a bot, or
 * undefined when it can: a bot step, then any number of (a condition, a yes,
 * both in that order or neither, then a bot step), at most `MAX_BOT_STEPS`
 * bot steps.
 */
export const routineStepsProblem = (steps: ReadonlyArray<RoutineStep>): string | undefined => {
  if (steps[0]?._tag !== "bot") return "A routine starts with a bot step.";
  if (steps.at(-1)?._tag !== "bot") return "A routine ends with a bot step.";
  let bots = 0;
  let since: "bot" | "condition" | "yes" = "bot";
  for (const step of steps) {
    switch (step._tag) {
      case "bot":
        bots += 1;
        since = "bot";
        break;
      case "condition":
        if (since !== "bot") return "A condition comes right after a bot step.";
        since = "condition";
        break;
      case "yes":
        if (since === "yes") return "Two yeses in a row ask the same thing twice.";
        since = "yes";
        break;
    }
  }
  return bots > MAX_BOT_STEPS ? `A routine has at most ${MAX_BOT_STEPS} bot steps.` : undefined;
};

/**
 * Whether `steps` make a routine of several steps rather than one: more than
 * one step, or one bot step by a bot other than `owner`.
 */
export const hasSeveralSteps = (
  steps: ReadonlyArray<RoutineStep> | undefined,
  owner: BotId,
): steps is ReadonlyArray<RoutineStep> =>
  steps !== undefined &&
  (steps.length > 1 || (steps[0]?._tag === "bot" && steps[0].botId !== owner));

/** Where one step of a run stands. */
export const RoutineRunStepState = Schema.Literals([
  /** Not reached yet. */
  "todo",
  /** A bot step at work, or waiting for its turn to start. */
  "doing",
  /** A bot step that reported. */
  "done",
  /** The step the run failed at, a bot step or a yes a Stop closed: see `failure`. */
  "failed",
  /** Not reached, since the run ended before it. */
  "skipped",
  /** A yes not asked: what it was asked only if did not hold. */
  "not-needed",
  /** A condition that held: the run went on. */
  "passed",
  /** A condition that did not hold: the run stopped there, quietly. */
  "stopped",
  /** A yes waiting for the operator. */
  "waiting",
  /** The operator said yes. */
  "yes",
  /** The operator said no: the run ended there. */
  "no",
  /** No answer by the deadline: the run ended there. */
  "timed-out",
]);
export type RoutineRunStepState = typeof RoutineRunStepState.Type;

/** Why a run failed at a step: a bot step, or, for a Stop, also a yes it waited at. */
export const RoutineStepFailure = Schema.Literals([
  /** The bot reported it could not go on; `result` says why, in its words. */
  "blocked",
  /** Its turn ended without a report. */
  "unreported",
  /** Its turn failed, or its attempts ran out. */
  "turn-failed",
  /** Its bot was deleted. */
  "bot-gone",
  /** The operator stopped the run. */
  "stopped",
]);
export type RoutineStepFailure = typeof RoutineStepFailure.Type;

/** What a yes asks, as the step before wrote it, and until when. */
export const RoutineAsk = Schema.Struct({
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  yes: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  no: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  deadline: Schema.DateTimeUtc,
});
export type RoutineAsk = typeof RoutineAsk.Type;

/** The operator's answer to a yes. */
export const RoutineAnswer = Schema.Struct({
  choice: Schema.Literals(["yes", "no"]),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  at: Schema.DateTimeUtc,
});
export type RoutineAnswer = typeof RoutineAnswer.Type;

/** One step of a run: the step as the run copied it when it started, and where it stands. */
export const RoutineRunStep = Schema.Struct({
  step: RoutineStep,
  state: RoutineRunStepState,
  /**
   * A bot step's line of result, as its bot reported it ("14 new emails"),
   * or, failed `blocked`, what stopped it; a condition's, the line of the
   * step before that it was judged on. Null otherwise.
   */
  result: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** A yes that was asked: what, and until when. */
  ask: Schema.optionalKey(RoutineAsk),
  answer: Schema.optionalKey(RoutineAnswer),
  failure: Schema.optionalKey(RoutineStepFailure),
  /**
   * A failed bot step whose turn had started, so it may have done part of
   * its work: Try again says so first.
   */
  partial: Schema.optionalKey(Schema.Boolean),
  /** A bot step whose attempt failed before its turn started: when it is tried again by itself. */
  retryAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type RoutineRunStep = typeof RoutineRunStep.Type;

/** Why a run of a routine with several steps notifies the operator. */
export const RoutineNotice = Schema.Struct({
  name: Label,
  reason: Schema.Literals(["yes", "failed"]),
  /** The bot of the step a failed run stopped at; null for a yes. */
  stepBotId: Schema.NullOr(BotId),
});
export type RoutineNotice = typeof RoutineNotice.Type;

/**
 * Why a run's last attempt failed, when J3 Bots can name it: the engine
 * refused the bot's permission mode, as an administrator's policy on its
 * machine can, so the attempt's session never opened or its turn never ran.
 * `allowed` is the highest mode the policy allows, when the engine names one.
 */
export const RoutineRunFailure = Schema.TaggedStruct("permission-mode-refused", {
  permissionMode: PermissionMode,
  allowed: Schema.NullOr(PermissionMode),
});
export type RoutineRunFailure = typeof RoutineRunFailure.Type;

export const RoutineRun = Schema.Struct({
  id: RoutineRunId,
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  status: Schema.Literals([
    "running",
    /** It said something: see `delivered`. */
    "delivered",
    /** It finished without saying anything; `note` holds its result, when it left one. */
    "silent",
    /** Its last attempt failed before it said anything, or a Stop or a deletion ended it. */
    "failed",
    /** It came due while the previous run was still going. */
    "skipped",
  ]),
  /**
   * How many of its attempts started: none for a skipped run, or one whose
   * first attempt still waits. An attempt that fails before the bot says
   * anything is tried again, a bounded number of times.
   */
  attempts: NonNegativeInt,
  delivered: Schema.Array(EntryId),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
  /**
   * Why its last attempt failed, on a failed run whose reason J3 Bots can
   * name. Absent otherwise, and from a server that names none.
   */
  failure: Schema.optionalKey(RoutineRunFailure),
  /**
   * When a scheduled run was due, on one that started more than a minute
   * after that: J3 Bots was not running then, or was busy recording others.
   * Absent on a run that started on time, on one a webhook or the operator
   * asked for, and from a server that does not record it.
   */
  dueAt: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * A run of a routine with several steps: each step as the run copied it,
   * and where it stands. Absent on a one-step routine's run, and from a
   * server that predates steps.
   */
  steps: Schema.optionalKey(Schema.Array(RoutineRunStep)),
  /** A failed run that Try again (`routine.retry`) resumes from the step it failed at. */
  retryable: Schema.optionalKey(Schema.Boolean),
});
export type RoutineRun = typeof RoutineRun.Type;

/**
 * How many missed runs this release's server counts at most: a count at this
 * limit means at least as many. A count is not checked against it as it is
 * read, so a later server may count further without a client failing to read
 * the routine.
 */
export const MISSED_RUNS_LIMIT = 1000;

/**
 * The scheduled runs a routine missed since its last run started: J3 Bots was
 * not running when they were due, and it was too late to make up the latest
 * of them when it came back, since its next run was nearer. `since` is the
 * first of them and `until` the last; one run's are the same.
 */
export const RoutineMissed = Schema.Struct({
  count: PositiveInt,
  since: Schema.DateTimeUtc,
  until: Schema.DateTimeUtc,
});
export type RoutineMissed = typeof RoutineMissed.Type;

export const Routine = Schema.Struct({
  id: RoutineId,
  botId: BotId,
  name: Label,
  /** The brief its run starts from; for a routine with several steps, its first step's. */
  instruction: RoutineInstruction,
  /**
   * Its steps (decision 0080), in order, for a routine with several. Absent
   * for a one-step routine, which `instruction` is all of and which is drawn
   * as it always was, and from a server that predates steps.
   */
  steps: Schema.optionalKey(Schema.Array(RoutineStep)),
  trigger: RoutineTrigger,
  enabled: Schema.Boolean,
  /** The webhook trigger's address, with its secret. Null for the other triggers. */
  webhookUrl: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.DateTimeUtc),
  lastRun: Schema.NullOr(RoutineRun),
  runCount: NonNegativeInt,
  /**
   * The runs it missed since its last run started, null when none. Cleared
   * when its next run starts, or when it is given a new trigger. Absent from
   * a server that does not count them.
   */
  missed: Schema.optionalKey(Schema.NullOr(RoutineMissed)),
});
export type Routine = typeof Routine.Type;
