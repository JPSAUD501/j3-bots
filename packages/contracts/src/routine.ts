// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, EntryId, Label, NonNegativeInt, RoutineId, RoutineRunId } from "./base.ts";

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

export const RoutineRun = Schema.Struct({
  id: RoutineRunId,
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  status: Schema.Literals([
    "running",
    /** It said something: see `delivered`. */
    "delivered",
    /** It finished without saying anything; `note` holds its result. */
    "silent",
    "failed",
    /** It came due while the previous run was still going. */
    "skipped",
  ]),
  delivered: Schema.Array(EntryId),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type RoutineRun = typeof RoutineRun.Type;

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
});
export type Routine = typeof Routine.Type;
