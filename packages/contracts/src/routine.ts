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
  instruction: RoutineInstruction,
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
