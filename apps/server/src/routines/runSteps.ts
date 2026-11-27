// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  RoutineAnswer,
  RoutineAsk,
  type RoutineBotStep,
  RoutineId,
  type RoutineRunEntry,
  RoutineRunId,
  RoutineStep,
  type RoutineStepFailure,
} from "@j3-bots/contracts";
import { TurnId } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Entries } from "../entries/Entries.ts";
import type { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import type { Ledger } from "../turns/Ledger.ts";
import { conversation, DispatchRowId, SessionRowId, TurnsInvariant } from "../turns/model.ts";
import type { Signals } from "../turns/Signals.ts";
import type { Wakes } from "../turns/Wakes.ts";
import { runView } from "./runView.ts";

/**
 * What a step's bot reported with `finish_step` (decision 0080): its line of
 * result, what the next steps need, whether the condition after it holds,
 * what to ask the operator, and whether it could not do the step.
 */
export const StepReport = Schema.Struct({
  result: Schema.String,
  handoff: Schema.NullOr(Schema.String),
  goOn: Schema.NullOr(Schema.Boolean),
  ask: Schema.NullOr(
    Schema.Struct({ question: Schema.String, yes: Schema.String, no: Schema.String }),
  ),
  blocked: Schema.Boolean,
});
export type StepReport = typeof StepReport.Type;

/** How long a yes waits when its step gives no time. */
export const DEFAULT_YES_HOURS = 24;

const encodeAsk = Schema.encodeEffect(json(RoutineAsk));
const encodeAnswer = Schema.encodeEffect(json(RoutineAnswer));
const encodeReport = Schema.encodeEffect(json(StepReport));

/** A run of a routine with several steps, as moving it needs it. */
const MovingRun = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  owner_id: BotId,
  steps_json: json(Schema.Array(RoutineStep)),
  next_run_at: Schema.NullOr(Time),
});
type MovingRun = typeof MovingRun.Type;

/** A step's turn a Stop of its run has to end, in the step bot's side session. */
export interface StepTurn {
  readonly botId: BotId;
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
}

const StepTurnRow = Schema.Struct({
  bot_id: BotId,
  session_id: SessionRowId,
  engine_turn_id: TurnId,
});

/**
 * The run's card in its owner's conversation (`routine-run`), brought up to
 * date with the run. `notify` tells the operator, as a new entry would: when
 * the run waits for their yes, or failed.
 */
export const runCards = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const view = runView(sql);

  const refresh = Effect.fn("runCards.refresh")(function* (runId: RoutineRunId, notify: boolean) {
    const row = yield* view.cardRow(runId);
    if (Option.isNone(row) || row.value.entry_id === null) return;
    const found = yield* entries.find(row.value.entry_id);
    if (Option.isNone(found) || found.value.entry._tag !== "routine-run") return;
    const card: RoutineRunEntry = {
      ...found.value.entry,
      name: row.value.name,
      trigger: row.value.trigger_json,
      run: yield* view.toRun(row.value),
    };
    yield* entries.update(card, { notify });
  }, Effect.orDie);

  /** Posts the run's card, at its start, and records where it is. */
  const post = Effect.fn("runCards.post")(function* (runId: RoutineRunId) {
    const row = yield* view.cardRow(runId);
    if (Option.isNone(row)) {
      return yield* Effect.die(
        new TurnsInvariant({ invariant: "A run with several steps is written before its card" }),
      );
    }
    const posted = yield* entries.append({
      target: { _tag: "conversation", botId: row.value.owner_id },
      entry: {
        _tag: "routine-run",
        author: { _tag: "bot", botId: row.value.owner_id },
        routineId: row.value.routine_id,
        name: row.value.name,
        trigger: row.value.trigger_json,
        run: yield* view.toRun(row.value),
      },
    });
    yield* sql`UPDATE routine_runs SET entry_id = ${posted.id} WHERE id = ${runId}`;
  }, Effect.orDie);

  return { refresh, post };
};
type RunCards = ReturnType<typeof runCards>;

/**
 * Stops runs of routines with several steps (decision 0080), in the caller's
 * transaction: the run fails as stopped, at the step it was at, a yes it
 * waits for closes, and its step's wake is cancelled, or its dispatch given
 * back unsent. The step's turn, if one runs in the step bot's side session,
 * is returned for a Stop of that turn alone (`Stops.endTurn`); one that has
 * not shown yet is ended by the routine runner once it does. A run ended by a
 * Stop is never tried again.
 */
export const runStops = (
  sql: SqlClient.SqlClient,
  ledger: Ledger["Service"],
  changes: ChangeLog["Service"],
  cards: RunCards,
) => {
  const goingOf = SqlSchema.findAll({
    Request: Schema.Struct({ runId: Schema.NullOr(RoutineRunId), ownerId: Schema.NullOr(BotId) }),
    Result: Schema.Struct({
      id: RoutineRunId,
      routine_id: RoutineId,
      owner_id: BotId,
      wake_id: Schema.NullOr(Schema.String),
      step: Schema.NullOr(Schema.Int),
    }),
    execute: ({ runId, ownerId }) => sql`
      SELECT r.id, r.routine_id, ro.bot_id AS owner_id, r.wake_id, r.step
      FROM routine_runs r JOIN routines ro ON ro.id = r.routine_id
      WHERE r.status = 'running' AND r.steps_json IS NOT NULL
        AND ${runId === null ? sql`ro.bot_id = ${ownerId}` : sql`r.id = ${runId}`}
    `,
  });

  const WakeState = Schema.Struct({
    status: Schema.String,
    dispatch_id: Schema.NullOr(DispatchRowId),
    dispatch_status: Schema.NullOr(Schema.String),
    attempts: Schema.NullOr(Schema.Int),
  });
  const wakeState = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WakeState,
    execute: (wakeId) => sql`
      SELECT w.status, w.dispatch_id, d.status AS dispatch_status, d.attempts
      FROM wakes w LEFT JOIN dispatches d ON d.id = w.dispatch_id
      WHERE w.id = ${wakeId}
    `,
  });

  /** The turn running in the side session of the step's wake. */
  const turnOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: StepTurnRow,
    execute: (wakeId) => sql`
      SELECT s.bot_id, s.id AS session_id, t.engine_turn_id
      FROM sessions s JOIN turns t ON t.session_id = s.id
      WHERE s.side_wake_id = ${wakeId} AND t.finished_at IS NULL
    `,
  });

  const stopOne = Effect.fn("runStops.stopOne")(function* (run: {
    readonly id: RoutineRunId;
    readonly routine_id: RoutineId;
    readonly owner_id: BotId;
    readonly wake_id: string | null;
    readonly step: number | null;
  }) {
    const at = timeText(yield* DateTime.now);
    if (run.step !== null) {
      yield* sql`
        UPDATE routine_run_steps
        SET state = 'failed', failure = 'stopped', deadline = NULL, finished_at = ${at}
        WHERE run_id = ${run.id} AND position = ${run.step} AND state IN ('doing', 'waiting')
      `;
    }
    yield* sql`UPDATE routine_run_steps SET state = 'skipped' WHERE run_id = ${run.id} AND state = 'todo'`;
    yield* sql`
      UPDATE routine_runs SET status = 'failed', stopped = 1, finished_at = ${at}, retry_at = NULL
      WHERE id = ${run.id} AND status = 'running'
    `;
    const turns: Array<StepTurn> = [];
    if (run.wake_id !== null) {
      const wake = yield* wakeState(run.wake_id);
      if (Option.isSome(wake)) {
        const { status, dispatch_id: dispatchId, dispatch_status, attempts } = wake.value;
        if (status === "pending") yield* ledger.cancelWakes([run.wake_id]);
        if (dispatchId !== null && dispatch_status === "intended" && attempts === 0) {
          yield* ledger.release(dispatchId, { _tag: "cancelled" });
        }
      }
      for (const turn of yield* turnOf(run.wake_id)) {
        turns.push({
          botId: turn.bot_id,
          sessionId: turn.session_id,
          turnId: turn.engine_turn_id,
        });
      }
    }
    yield* changes.record({ _tag: "routines", botId: run.owner_id }, run.routine_id);
    yield* cards.refresh(run.id, false);
    return turns;
  });

  /** Stops the run if it is going; none when it is over. */
  const stopRun = Effect.fn("runStops.stopRun")(function* (runId: RoutineRunId) {
    const [run] = yield* goingOf({ runId, ownerId: null });
    if (run === undefined) return Option.none<ReadonlyArray<StepTurn>>();
    return Option.some(yield* stopOne(run));
  }, Effect.orDie);

  /** Stops every going run of the owner's routines, as a Stop of the owner does. */
  const stopRunsOf = Effect.fn("runStops.stopRunsOf")(function* (ownerId: BotId) {
    const turns: Array<StepTurn> = [];
    for (const run of yield* goingOf({ runId: null, ownerId })) {
      turns.push(...(yield* stopOne(run)));
    }
    return turns;
  }, Effect.orDie);

  return { stopRun, stopRunsOf };
};

/** What a step's attempt came to, as its wake and the turn it ran tell. */
export type StepOutcome =
  | { readonly _tag: "going" }
  /** Its wake is gone: its bot was deleted. */
  | { readonly _tag: "bot-gone" }
  /** A Stop of the step's bot ended it; `partial` when its turn had started. */
  | { readonly _tag: "stopped"; readonly partial: boolean }
  /**
   * Its turn never started. `retry` records the step's next attempt and is
   * true while attempts are left and the engine did not refuse its envelope.
   */
  | { readonly _tag: "never-started"; readonly retry: Effect.Effect<boolean> }
  /** Its turn ended, completed or not. */
  | { readonly _tag: "ended"; readonly completed: boolean };

/** What answering a yes came to. */
export type AnswerOutcome = "answered" | "closed";

/**
 * The step machine of a run of a routine with several steps (decision 0080),
 * every move in the caller's transaction: a run starts at its first bot step;
 * a bot step that reported moves the run on, through the conditions and the
 * yes after it, to the next bot step; a yes waits for the operator until its
 * deadline; and a run ends delivered, silent or failed, with its card brought
 * up to date at each move.
 */
export const runSteps = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly wakes: Wakes["Service"];
  readonly changes: ChangeLog["Service"];
  readonly signals: Signals["Service"];
  readonly cards: RunCards;
  /** Settles the run, which then joins the routine's kept history. */
  readonly finish: (
    run: { readonly id: RoutineRunId; readonly routine_id: RoutineId; readonly bot_id: BotId },
    status: "delivered" | "silent" | "failed",
    at: DateTime.Utc,
  ) => Effect.Effect<void>;
}) => {
  const { sql, wakes, changes, signals, cards, finish } = deps;

  const movingRun = SqlSchema.findOneOption({
    Request: RoutineRunId,
    Result: MovingRun,
    execute: (runId) => sql`
      SELECT r.id, r.routine_id, ro.bot_id AS owner_id, r.steps_json, ro.next_run_at
      FROM routine_runs r JOIN routines ro ON ro.id = r.routine_id
      WHERE r.id = ${runId} AND r.status = 'running' AND r.steps_json IS NOT NULL
    `,
  });

  const storedReport = SqlSchema.findOneOption({
    Request: Schema.Struct({ runId: RoutineRunId, position: Schema.Int, wakeId: Schema.String }),
    Result: Schema.Struct({ report_json: json(StepReport) }),
    execute: ({ runId, position, wakeId }) => sql`
      SELECT report_json FROM routine_run_steps
      WHERE run_id = ${runId} AND position = ${position} AND report_wake_id = ${wakeId}
        AND report_json IS NOT NULL
    `,
  });

  const touch = Effect.fn("runSteps.touch")(function* (run: MovingRun, notify: boolean) {
    yield* changes.record({ _tag: "routines", botId: run.owner_id }, run.routine_id);
    yield* cards.refresh(run.id, notify);
  });

  const identified = (run: MovingRun) => ({
    id: run.id,
    routine_id: run.routine_id,
    bot_id: run.owner_id,
  });

  /** Ends the run: the steps it did not reach are skipped. */
  const end = Effect.fn("runSteps.end")(function* (
    run: MovingRun,
    status: "delivered" | "silent" | "failed",
    at: DateTime.Utc,
  ) {
    yield* sql`UPDATE routine_run_steps SET state = 'skipped' WHERE run_id = ${run.id} AND state = 'todo'`;
    yield* finish(identified(run), status, at);
    yield* cards.refresh(run.id, status === "failed");
  });

  /** Every step ran, or the run stopped quietly: delivered when one of its steps spoke. */
  const complete = Effect.fn("runSteps.complete")(function* (run: MovingRun, at: DateTime.Utc) {
    const spoke = yield* sql`
      SELECT 1 FROM routine_run_steps WHERE run_id = ${run.id} AND spoke = 1
    `;
    yield* end(run, spoke.length > 0 ? "delivered" : "silent", at);
  });

  /** Fails the run at a bot step. */
  const fail = Effect.fn("runSteps.fail")(function* (
    run: MovingRun,
    position: number,
    failure: RoutineStepFailure,
    detail: { readonly partial: boolean; readonly result: string | null },
    at: DateTime.Utc,
  ) {
    yield* sql`
      UPDATE routine_run_steps
      SET state = 'failed', failure = ${failure}, partial = ${detail.partial ? 1 : 0},
        result = COALESCE(${detail.result}, result), deadline = NULL, finished_at = ${timeText(at)}
      WHERE run_id = ${run.id} AND position = ${position}
    `;
    if (failure === "stopped") {
      yield* sql`UPDATE routine_runs SET stopped = 1 WHERE id = ${run.id}`;
    }
    yield* end(run, "failed", at);
  });

  /**
   * Starts the bot step at `position`: a routine wake of its bot, which the
   * runner gives a side session of that bot. A bot deleted since fails it.
   */
  const startBot = Effect.fn("runSteps.startBot")(function* (
    run: MovingRun,
    position: number,
    step: RoutineBotStep,
    at: DateTime.Utc,
  ) {
    const exists = yield* sql`SELECT 1 FROM bots WHERE id = ${step.botId}`;
    if (exists.length === 0) {
      return yield* fail(run, position, "bot-gone", { partial: false, result: null }, at);
    }
    const [wakeId] = yield* wakes.record([
      {
        botId: step.botId,
        kind: "routine",
        audience: conversation,
        payload: { _tag: "routine", routineId: run.routine_id, runId: run.id },
        sourceEntryId: null,
        hops: 0,
        retryOf: null,
        cause: { _tag: "routine" },
      },
    ]);
    if (wakeId === undefined) {
      return yield* Effect.die(
        new TurnsInvariant({ invariant: "A routine's wake is always written" }),
      );
    }
    yield* sql`
      UPDATE routine_runs
      SET wake_id = ${wakeId}, step = ${position}, attempts = 0, retry_at = NULL,
        failure_json = NULL
      WHERE id = ${run.id}
    `;
    yield* sql`
      UPDATE routine_run_steps
      SET state = 'doing', started_at = ${timeText(at)}, finished_at = NULL, failure = NULL,
        partial = 0, result = NULL, report_json = NULL, report_wake_id = NULL
      WHERE run_id = ${run.id} AND position = ${position}
    `;
    yield* touch(run, false);
    yield* sql.afterCommit(signals.routines.fire);
  });

  /**
   * When a yes opened at `at` closes: after the hours its step allows, and
   * no later than the routine's next scheduled run.
   */
  const deadlineOf = (run: MovingRun, hours: number, at: DateTime.Utc): DateTime.Utc => {
    const allowed = DateTime.addDuration(at, Duration.hours(hours));
    return run.next_run_at !== null && DateTime.isLessThan(run.next_run_at, allowed)
      ? run.next_run_at
      : allowed;
  };

  /**
   * Moves the run on from the bot step at `from`, which reported `report`:
   * through the condition and the yes after it, to the next bot step, or to
   * the run's end.
   */
  const goOn = Effect.fn("runSteps.goOn")(function* (
    run: MovingRun,
    from: number,
    report: StepReport,
    at: DateTime.Utc,
  ) {
    const atText = timeText(at);
    for (let position = from + 1; ; position++) {
      const step = run.steps_json[position];
      if (step === undefined) return yield* complete(run, at);
      switch (step._tag) {
        case "bot":
          return yield* startBot(run, position, step, at);
        case "condition": {
          const holds = report.goOn === true;
          yield* sql`
            UPDATE routine_run_steps
            SET state = ${holds ? "passed" : "stopped"}, result = ${report.result},
              started_at = ${atText}, finished_at = ${atText}
            WHERE run_id = ${run.id} AND position = ${position}
          `;
          if (!holds) return yield* complete(run, at);
          continue;
        }
        case "yes": {
          if (report.ask === null) {
            if (step.onlyIf === null) {
              // `finish_step` takes no report without what a yes asks.
              return yield* fail(run, from, "unreported", { partial: true, result: null }, at);
            }
            yield* sql`
              UPDATE routine_run_steps
              SET state = 'not-needed', started_at = ${atText}, finished_at = ${atText}
              WHERE run_id = ${run.id} AND position = ${position}
            `;
            continue;
          }
          const deadline = deadlineOf(run, step.waitHours, at);
          const ask: RoutineAsk = { ...report.ask, deadline };
          yield* sql`
            UPDATE routine_run_steps
            SET state = 'waiting', ask_json = ${yield* encodeAsk(ask).pipe(Effect.orDie)},
              deadline = ${timeText(deadline)}, started_at = ${atText}
            WHERE run_id = ${run.id} AND position = ${position}
          `;
          yield* sql`UPDATE routine_runs SET step = ${position} WHERE id = ${run.id}`;
          yield* touch(run, true);
          // The runner applies the deadline when it comes.
          yield* sql.afterCommit(signals.routines.fire);
          return;
        }
      }
    }
  });

  /**
   * Starts a run of a routine with several steps, its row just written
   * with the copy of its steps: a row for each step, its card in its
   * owner's conversation, and its first bot step. A step whose bot no
   * longer exists fails the run at once, naming that step.
   */
  const begin = Effect.fn("runSteps.begin")(function* (runId: RoutineRunId) {
    const found = yield* movingRun(runId).pipe(Effect.orDie);
    if (Option.isNone(found)) {
      return yield* Effect.die(
        new TurnsInvariant({ invariant: "A run with several steps is written before it begins" }),
      );
    }
    const run = found.value;
    for (const [position] of run.steps_json.entries()) {
      yield* sql`
        INSERT INTO routine_run_steps (run_id, position, state)
        VALUES (${run.id}, ${position}, 'todo')
      `;
    }
    yield* cards.post(run.id);
    const at = yield* DateTime.now;
    for (const [position, step] of run.steps_json.entries()) {
      if (step._tag !== "bot") continue;
      const exists = yield* sql`SELECT 1 FROM bots WHERE id = ${step.botId}`;
      if (exists.length === 0) {
        return yield* fail(run, position, "bot-gone", { partial: false, result: null }, at);
      }
    }
    const first = run.steps_json[0];
    if (first?._tag !== "bot") {
      return yield* Effect.die(
        new TurnsInvariant({ invariant: "A routine starts with a bot step" }),
      );
    }
    yield* startBot(run, 0, first, at);
  }, Effect.orDie);

  /**
   * Records what a step's bot reported, for the attempt whose wake it is,
   * once: the run moves on from it when that attempt's turn has ended. False
   * when the step already has its report from this attempt.
   */
  const report = Effect.fn("runSteps.report")(function* (
    runId: RoutineRunId,
    wakeId: string,
    reported: StepReport,
  ) {
    const written = yield* sql`
      UPDATE routine_run_steps
      SET report_json = ${yield* encodeReport(reported).pipe(Effect.orDie)},
        report_wake_id = ${wakeId}, result = ${reported.result}
      WHERE run_id = ${runId} AND state = 'doing' AND report_wake_id IS NULL
        AND position = (
          SELECT step FROM routine_runs
          WHERE id = ${runId} AND wake_id = ${wakeId} AND status = 'running'
        )
      RETURNING position
    `;
    return written.length > 0;
  }, Effect.orDie);

  /** What the step's attempt that ended came to, from its wake and the turn it ran. */
  const settle = Effect.fn("runSteps.settle")(function* (ended: {
    readonly id: RoutineRunId;
    readonly position: number;
    readonly wakeId: string | null;
    readonly outcome: StepOutcome;
    readonly spoke: boolean;
    readonly at: DateTime.Utc;
  }) {
    if (ended.outcome._tag === "going") return;
    const found = yield* movingRun(ended.id).pipe(Effect.orDie);
    if (Option.isNone(found)) return;
    const run = found.value;
    const { position, at } = ended;
    if (ended.spoke) {
      yield* sql`
        UPDATE routine_run_steps SET spoke = 1 WHERE run_id = ${run.id} AND position = ${position}
      `;
    }
    switch (ended.outcome._tag) {
      case "bot-gone":
        return yield* fail(run, position, "bot-gone", { partial: false, result: null }, at);
      case "never-started":
        if (yield* ended.outcome.retry) return yield* touch(run, false);
        return yield* fail(run, position, "turn-failed", { partial: false, result: null }, at);
      case "stopped":
      case "ended": {
        const stored =
          ended.wakeId === null
            ? Option.none()
            : yield* storedReport({ runId: run.id, position, wakeId: ended.wakeId }).pipe(
                Effect.orDie,
              );
        if (Option.isSome(stored)) {
          const reported = stored.value.report_json;
          if (reported.blocked) {
            return yield* fail(
              run,
              position,
              "blocked",
              { partial: false, result: reported.result },
              at,
            );
          }
          yield* sql`
            UPDATE routine_run_steps SET state = 'done', finished_at = ${timeText(at)}
            WHERE run_id = ${run.id} AND position = ${position}
          `;
          return yield* goOn(run, position, reported, at);
        }
        if (ended.outcome._tag === "stopped") {
          return yield* fail(
            run,
            position,
            "stopped",
            { partial: ended.outcome.partial, result: null },
            at,
          );
        }
        return yield* fail(
          run,
          position,
          ended.outcome.completed ? "unreported" : "turn-failed",
          { partial: true, result: null },
          at,
        );
      }
    }
  });

  /**
   * The operator's answer to the yes the run waits for, while it is open: a
   * yes starts the next bot step, with the note; a no ends the run quietly.
   * An answer to a yes the deadline or a Stop closed is `closed`, and starts
   * nothing.
   */
  const answer = Effect.fn("runSteps.answer")(function* (input: {
    readonly runId: RoutineRunId;
    readonly choice: RoutineAnswer["choice"];
    readonly note: string | null;
  }) {
    const at = yield* DateTime.now;
    yield* expire(at);
    const found = yield* movingRun(input.runId).pipe(Effect.orDie);
    if (Option.isNone(found)) return "closed" satisfies AnswerOutcome;
    const run = found.value;
    const answered: RoutineAnswer = { choice: input.choice, note: input.note, at };
    const closed = yield* sql<{ readonly position: number }>`
      UPDATE routine_run_steps
      SET state = ${input.choice}, answer_json = ${yield* encodeAnswer(answered).pipe(Effect.orDie)},
        deadline = NULL, finished_at = ${timeText(at)}
      WHERE run_id = ${run.id} AND state = 'waiting'
        AND position = (SELECT step FROM routine_runs WHERE id = ${run.id})
      RETURNING position
    `;
    const [yes] = closed;
    if (yes === undefined) return "closed" satisfies AnswerOutcome;
    if (input.choice === "no") {
      yield* complete(run, at);
      return "answered" satisfies AnswerOutcome;
    }
    const next = run.steps_json[yes.position + 1];
    if (next?._tag !== "bot") {
      return yield* Effect.die(new TurnsInvariant({ invariant: "A bot step follows a yes" }));
    }
    yield* startBot(run, yes.position + 1, next, at);
    return "answered" satisfies AnswerOutcome;
  }, Effect.orDie);

  /**
   * Closes every yes whose deadline has come, of one routine or of all: the
   * run ends there, quietly. Returns the earliest deadline still to come.
   */
  const expire = Effect.fn("runSteps.expire")(function* (
    at: DateTime.Utc,
    routineId: RoutineId | null = null,
  ) {
    const due = yield* sql<{ readonly run_id: string; readonly position: number }>`
      SELECT s.run_id, s.position FROM routine_run_steps s
      JOIN routine_runs r ON r.id = s.run_id
      WHERE s.state = 'waiting' AND s.deadline <= ${timeText(at)} AND r.status = 'running'
        ${routineId === null ? sql`` : sql`AND r.routine_id = ${routineId}`}
    `;
    for (const waiting of due) {
      const runId = RoutineRunId.make(waiting.run_id);
      const found = yield* movingRun(runId).pipe(Effect.orDie);
      if (Option.isNone(found)) continue;
      yield* sql`
        UPDATE routine_run_steps
        SET state = 'timed-out', deadline = NULL, finished_at = ${timeText(at)}
        WHERE run_id = ${runId} AND position = ${waiting.position}
      `;
      yield* complete(found.value, at);
    }
    const [next] = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ deadline: Time }),
      execute: () => sql`
        SELECT MIN(deadline) AS deadline FROM routine_run_steps
        WHERE state = 'waiting' HAVING MIN(deadline) IS NOT NULL
      `,
    })(undefined).pipe(Effect.orDie);
    return Option.fromNullishOr(next?.deadline);
  }, Effect.orDie);

  /**
   * Try again: resumes the run from the bot step it failed at, keeping what
   * the steps before reported and the operator's answers. False when the run
   * is not one Try again resumes (`RoutineRun.retryable`).
   */
  const retry = Effect.fn("runSteps.retry")(function* (runId: RoutineRunId, retryable: boolean) {
    if (!retryable) return false;
    const [failed] = yield* sql<{ readonly position: number }>`
      SELECT position FROM routine_run_steps
      WHERE run_id = ${runId} AND state = 'failed'
    `;
    if (failed === undefined) return false;
    const reopened = yield* sql`
      UPDATE routine_runs SET status = 'running', finished_at = NULL
      WHERE id = ${runId} AND status = 'failed' AND stopped = 0
      RETURNING id
    `;
    if (reopened.length === 0) return false;
    yield* sql`
      UPDATE routine_run_steps SET state = 'todo', started_at = NULL, finished_at = NULL
      WHERE run_id = ${runId} AND state = 'skipped'
    `;
    const found = yield* movingRun(runId).pipe(Effect.orDie);
    if (Option.isNone(found)) return false;
    const step = found.value.steps_json[failed.position];
    if (step?._tag !== "bot") {
      return yield* Effect.die(new TurnsInvariant({ invariant: "A run fails at a bot step" }));
    }
    yield* startBot(found.value, failed.position, step, yield* DateTime.now);
    return true;
  }, Effect.orDie);

  return { begin, report, settle, answer, expire, retry };
};
