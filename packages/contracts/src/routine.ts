// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import {
  BotId,
  ConnectorId,
  EntryId,
  Label,
  NonNegativeInt,
  OpenLiterals,
  PositiveInt,
  RoutineId,
  RoutineRunId,
} from "./base.ts";
import { PermissionMode } from "./bot.ts";

/** The most an event's name takes, as a connector's server names it (`email.received`). */
export const MAX_EVENT_NAME_LENGTH = 256;

/** The most an event trigger's arguments take, as JSON, in bytes. */
export const MAX_EVENT_ARGUMENTS_BYTES = 4096;

/** The name of an event a connector's server offers, as it names it. */
export const EventName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_EVENT_NAME_LENGTH),
);

/**
 * What an event trigger asks its connector's server for, as the event's
 * `inputSchema` takes it: a filter, such as a sender, or a setting of the
 * event's own. At most {@link MAX_EVENT_ARGUMENTS_BYTES} as JSON.
 */
export const EventArguments = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EVENT_ARGUMENTS_BYTES ||
      `at most ${MAX_EVENT_ARGUMENTS_BYTES} bytes as JSON`,
  ),
);
export type EventArguments = typeof EventArguments.Type;

/**
 * A connector's event (MCP's Events extension, `io.modelcontextprotocol/events`):
 * the routine runs when the connector's server says it happened. Only a bot
 * sets one (`set_routine`), from what the connector offers. `summary` is the
 * bot's own words for the event, in the operator's language, as a sentence
 * reads after "When <connector> says": "a new email from Ana arrives".
 */
export const EventTrigger = Schema.TaggedStruct("event", {
  connectorId: ConnectorId,
  name: EventName,
  arguments: EventArguments,
  summary: Label,
});
export type EventTrigger = typeof EventTrigger.Type;

/**
 * A trigger J3 Bots' server fires on its own: by its clock, or when its
 * webhook is called. Every client of protocol 11 reads these.
 */
export const OwnTrigger = Schema.Union([
  /** A five-field cron expression, evaluated in `timeZone` (an IANA name). */
  Schema.TaggedStruct("schedule", { cron: Label, timeZone: Label }),
  /** One run at `at`. The routine pauses itself once that run has started. */
  Schema.TaggedStruct("once", { at: Schema.DateTimeUtc }),
  /** An HTTP endpoint on the J3 Bots server. */
  Schema.TaggedStruct("webhook", {}),
]);
export type OwnTrigger = typeof OwnTrigger.Type;

/**
 * What runs a routine: one of J3 Bots' own triggers, or a connector's event.
 * The event is new in 0.13.0 within protocol 11: a server sends a routine
 * with it only to a client that says it reads one (`routines.subscribe`'s
 * `withEvents`), and its changes as an entry of their own kind
 * (`EventRoutineChangeEntry`), which an older client passes over as one it
 * does not know.
 */
export const RoutineTrigger = Schema.Union([...OwnTrigger.members, EventTrigger]);
export type RoutineTrigger = typeof RoutineTrigger.Type;

/**
 * Why J3 Bots stopped listening for a routine's event, in words a client
 * gives: the connector's server ended it, refused it, or no longer offers
 * it, or the connector is gone. Open: one a client does not know decodes as
 * `unknown`, which it words as a stop it cannot name.
 */
export const EVENT_STOP_REASONS = [
  /** The server ended or refused it: the account no longer has access. */
  "access-revoked",
  /** The server no longer offers the event, or changed what it takes. */
  "event-gone",
  /** The connector was removed, or the routine's bot can no longer use it. */
  "connector-gone",
  /** The server refused what the trigger asks for. */
  "refused",
] as const;
export const EventStopReason = Schema.Literals(EVENT_STOP_REASONS);
export type EventStopReason = typeof EventStopReason.Type;

/**
 * Whether J3 Bots is listening for an event routine's event now: `listening`,
 * `waiting` while its connector is not connected or does not answer (J3 Bots
 * keeps trying), or `stopped`, which only a new trigger or a resume undoes.
 */
export const RoutineListening = Schema.Union([
  Schema.TaggedStruct("listening", {}),
  Schema.TaggedStruct("waiting", { since: Schema.DateTimeUtc }),
  Schema.TaggedStruct("stopped", {
    reason: OpenLiterals(EVENT_STOP_REASONS),
    since: Schema.DateTimeUtc,
  }),
]);
export type RoutineListening = typeof RoutineListening.Type;

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
  /**
   * For an event routine that is on, whether J3 Bots is listening for its
   * event. Absent for every other routine, and for a paused one.
   */
  listening: Schema.optionalKey(RoutineListening),
  /**
   * For an event routine, its connector's name as it is now, which the
   * routine's trigger is worded with ("When Mail says …"); null once the
   * connector is removed. Absent for every other routine.
   */
  connectorName: Schema.optionalKey(Schema.NullOr(Label)),
});
export type Routine = typeof Routine.Type;
