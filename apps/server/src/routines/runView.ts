// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  NonNegativeInt,
  RoutineAnswer,
  RoutineAsk,
  RoutineId,
  type RoutineRun,
  RoutineRunFailure,
  RoutineRunId,
  type RoutineRunStep,
  RoutineRunStepState,
  RoutineStep,
  RoutineStepFailure,
  RoutineTrigger,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";

/**
 * How long after it was due a run starts before it counts as late: clients
 * are told when it was due, and so is the bot. The scheduler records a run
 * within seconds of its time while the server runs.
 */
const LATE_AFTER = Duration.minutes(1);

/** Whether a run due at `due` that starts at `start` is late. */
export const isLate = (due: DateTime.Utc, start: DateTime.Utc): boolean =>
  Duration.isGreaterThan(DateTime.distance(due, start), LATE_AFTER);

/** A run's row, as clients are shown it. */
export const RunRow = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  wake_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "delivered", "silent", "failed", "skipped"]),
  attempts: NonNegativeInt,
  note: Schema.NullOr(Schema.String),
  started_at: Time,
  finished_at: Schema.NullOr(Time),
  failure_json: Schema.NullOr(json(RoutineRunFailure)),
  due_at: Schema.NullOr(Time),
  steps_json: Schema.NullOr(json(Schema.Array(RoutineStep))),
  stopped: Flag,
  retry_at: Schema.NullOr(Time),
});
export type RunRow = typeof RunRow.Type;

/** The columns of `routine_runs` a {@link RunRow} reads. */
export const RUN_COLUMNS = `
  id, routine_id, wake_id, status, attempts, note, started_at, finished_at, failure_json, due_at,
  steps_json, stopped, retry_at
`;

/** A run of a routine with several steps, with what its card names. */
const CardRow = Schema.Struct({
  ...RunRow.fields,
  entry_id: Schema.NullOr(EntryId),
  owner_id: BotId,
  name: Schema.String,
  trigger_json: json(RoutineTrigger),
  /** For a trigger on a connector's event, the connector's name; null once it is removed. */
  connector_name: Schema.NullOr(Schema.String),
});

const StepRow = Schema.Struct({
  position: NonNegativeInt,
  state: RoutineRunStepState,
  result: Schema.NullOr(Schema.String),
  ask_json: Schema.NullOr(json(RoutineAsk)),
  answer_json: Schema.NullOr(json(RoutineAnswer)),
  failure: Schema.NullOr(RoutineStepFailure),
  partial: Flag,
  started_at: Schema.NullOr(Time),
  finished_at: Schema.NullOr(Time),
});

/** Why a step failed that the operator can try again once it is fixed. */
const RETRYABLE: ReadonlyArray<RoutineStepFailure> = ["blocked", "unreported", "turn-failed"];

/**
 * Runs as clients are shown them (`RoutineRun`), from their rows: a run of a
 * routine with several steps also with its steps, each where it stands, and
 * whether Try again resumes it (decision 0080).
 */
export const runView = (sql: SqlClient.SqlClient) => {
  const stepRows = SqlSchema.findAll({
    Request: RoutineRunId,
    Result: StepRow,
    execute: (runId) => sql`
      SELECT position, state, result, ask_json, answer_json, failure, partial, started_at,
        finished_at
      FROM routine_run_steps WHERE run_id = ${runId} ORDER BY position
    `,
  });

  /** Each of the run's steps, as it copied them, with where it stands. */
  const stepsOf = Effect.fn("runView.stepsOf")(function* (
    row: RunRow,
    steps: ReadonlyArray<RoutineStep>,
  ) {
    const rows = yield* stepRows(row.id);
    return rows.flatMap((step): ReadonlyArray<RoutineRunStep> => {
      const copied = steps[step.position];
      if (copied === undefined) return [];
      return [
        {
          step: copied,
          state: step.state,
          result: step.result,
          startedAt: step.started_at,
          finishedAt: step.finished_at,
          ...(step.ask_json === null ? {} : { ask: step.ask_json }),
          ...(step.answer_json === null ? {} : { answer: step.answer_json }),
          ...(step.failure === null ? {} : { failure: step.failure }),
          ...(step.partial ? { partial: true } : {}),
          ...(step.state === "doing" && row.retry_at !== null ? { retryAt: row.retry_at } : {}),
        },
      ];
    });
  });

  /**
   * Whether Try again resumes the run: it failed at a bot step, not by a
   * Stop or a missing bot; it is its routine's latest run, with none going;
   * and every bot of its steps still exists.
   */
  const retryable = Effect.fn("runView.retryable")(function* (
    row: RunRow,
    steps: ReadonlyArray<RoutineRunStep>,
  ) {
    if (row.status !== "failed" || row.stopped) return false;
    const failed = steps.find((step) => step.state === "failed");
    if (failed?.failure === undefined || !RETRYABLE.includes(failed.failure)) return false;
    const later = yield* sql`
      SELECT 1 FROM routine_runs
      WHERE routine_id = ${row.routine_id} AND id <> ${row.id} AND (
        status = 'running'
        OR (status <> 'skipped' AND (started_at, id) > (${timeText(row.started_at)}, ${row.id}))
      )
    `;
    if (later.length > 0) return false;
    const botIds = [
      ...new Set(steps.flatMap(({ step }) => (step._tag === "bot" ? [step.botId] : []))),
    ];
    const found = yield* sql`SELECT 1 FROM bots WHERE ${sql.in("id", botIds)}`;
    return found.length === botIds.length;
  });

  /**
   * What the run said to the operator: a one-step run's last attempt's
   * messages, which settled it; every step's, for a run with several.
   */
  const deliveredOf = (row: RunRow) =>
    row.steps_json !== null
      ? sql<{ readonly id: string }>`
          SELECT e.id FROM entries e JOIN wakes w ON w.id = e.wake_id
          WHERE w.routine_id = ${row.routine_id}
            AND json_extract(w.payload_json, '$.runId') = ${row.id}
            AND e.author_kind = 'bot' AND e.kind = 'message'
          ORDER BY e.seq
        `
      : row.wake_id === null
        ? Effect.succeed([])
        : sql<{ readonly id: string }>`
            SELECT id FROM entries
            WHERE wake_id = ${row.wake_id} AND author_kind = 'bot' AND kind = 'message'
            ORDER BY seq
          `;

  const toRun = Effect.fn("runView.toRun")(function* (row: RunRow) {
    const delivered = yield* deliveredOf(row);
    const steps = row.steps_json === null ? null : yield* stepsOf(row, row.steps_json);
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      attempts: row.attempts,
      delivered: delivered.map((entry) => EntryId.make(entry.id)),
      note: row.note,
      ...(row.status === "failed" && row.failure_json !== null
        ? { failure: row.failure_json }
        : {}),
      ...(row.due_at !== null && isLate(row.due_at, row.started_at) ? { dueAt: row.due_at } : {}),
      ...(steps === null ? {} : { steps, retryable: yield* retryable(row, steps) }),
    } satisfies RoutineRun;
  }, Effect.orDie);

  const cardRow = SqlSchema.findOneOption({
    Request: RoutineRunId,
    Result: CardRow,
    execute: (runId) => sql`
      SELECT r.id, r.routine_id, r.wake_id, r.status, r.attempts, r.note, r.started_at,
        r.finished_at, r.failure_json, r.due_at, r.steps_json, r.stopped, r.retry_at, r.entry_id,
        ro.bot_id AS owner_id, ro.name, ro.trigger_json,
        (
          SELECT c.name FROM connectors c
          WHERE c.id = json_extract(ro.trigger_json, '$.connectorId')
        ) AS connector_name
      FROM routine_runs r JOIN routines ro ON ro.id = r.routine_id
      WHERE r.id = ${runId} AND r.steps_json IS NOT NULL
    `,
  });

  return { toRun, cardRow };
};
