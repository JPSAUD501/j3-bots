// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoutineId, RoutineTrigger } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { DEFECT_RETRY, RETRY_TICK } from "../turns/reconciler.ts";
import { RoutineRuns } from "./RoutineRuns.ts";
import { nextRun } from "./schedule.ts";

/**
 * How long the scheduler waits with no routine due and no nudge before it
 * looks again: how late a run whose wake ended is settled at the most.
 */
const HEARTBEAT = Duration.minutes(1);

/** A routine whose next run has come, as the pass reads it: the text of its columns. */
const DueRef = Schema.Struct({
  id: Schema.String,
  next_run_at: Schema.String,
  trigger_json: Schema.String,
});
type DueRef = typeof DueRef.Type;

/** A routine still due, as its run is recorded. */
const Due = Schema.Struct({
  id: RoutineId,
  bot_id: BotId,
  trigger_json: json(RoutineTrigger),
});

/**
 * The routine scheduler (`docs/architecture/server.md`, Routines), a worker
 * over durable state like the turn machinery's. A pass settles the runs whose
 * wakes ended, then records a run of every enabled routine whose next run has
 * come, in the transaction that moves it on to the run after: a schedule to
 * its next time after now, a one-time trigger, or a schedule that no longer
 * has a next run, to paused. Runs missed while the server was down are
 * therefore not replayed: a routine that missed any runs once when the server
 * is back, and goes on from there. The worker looks again
 * at the earliest next run, when a routine changes, and once a minute
 * otherwise; it does not wait for the engine, since a run only records a wake.
 */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    /** One pass: settles ended runs and records the runs that came due. */
    readonly pass: Effect.Effect<void>;
    /** A routine's next run changed: the scheduler looks again now. */
    readonly nudge: Effect.Effect<void>;
  }
>()("@j3-bots/server/routines/Scheduler") {}

export const layer = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const runs = yield* RoutineRuns;
    const changes = yield* ChangeLog;
    const nudges = yield* Queue.sliding<void>(1);
    const permit = yield* Semaphore.make(1);

    const dueRefs = SqlSchema.findAll({
      Request: Schema.String,
      Result: DueRef,
      execute: (now) => sql`
        SELECT id, next_run_at, trigger_json FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now}
        ORDER BY next_run_at, id
      `,
    });

    const stillDue = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, now: Schema.String }),
      Result: Due,
      execute: ({ id, now }) => sql`
        SELECT id, bot_id, trigger_json FROM routines
        WHERE id = ${id} AND enabled = 1 AND next_run_at <= ${now}
      `,
    });

    const postponed = SqlSchema.findAll({
      Request: Schema.Struct({ ...DueRef.fields, at: Schema.String }),
      Result: Schema.Struct({ id: RoutineId, bot_id: BotId }),
      execute: (ref) => sql`
        UPDATE routines SET next_run_at = ${ref.at}
        WHERE id = ${ref.id} AND enabled = 1
          AND next_run_at = ${ref.next_run_at} AND trigger_json = ${ref.trigger_json}
        RETURNING id, bot_id
      `,
    });

    const earliest = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ next_run_at: Time }),
      execute: () => sql`
        SELECT next_run_at FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL
        ORDER BY next_run_at LIMIT 1
      `,
    });

    /**
     * Records the run of one routine that came due and moves it on, in one
     * transaction, if it is still due. The routine is read again there, so a
     * change committed since the pass read it wins: an edited trigger plans
     * the run after, a paused routine records none.
     */
    const start = Effect.fn("Scheduler.start")(function* (ref: DueRef) {
      yield* transaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const row = yield* stillDue({ id: ref.id, now: timeText(now) });
          if (Option.isNone(row)) return;
          const routine = row.value;
          const next = nextRun(routine.trigger_json, now);
          if (Result.isFailure(next)) {
            // Saved schedules have a next run; one that no longer has (a zone
            // the runtime no longer knows) runs this once and is paused, for
            // the operator to edit.
            yield* Effect.logWarning("A routine's schedule cannot be read; it is paused", {
              routineId: routine.id,
              reason: next.failure.reason,
            });
          }
          const after = Result.isSuccess(next) ? Option.getOrNull(next.success) : null;
          // A routine with no run left (a one-time trigger, an unreadable schedule) is paused.
          yield* sql`
            UPDATE routines SET
              next_run_at = ${after === null ? null : timeText(after)},
              enabled = ${after === null ? 0 : 1},
              updated_at = ${timeText(now)}
            WHERE id = ${routine.id}
          `;
          yield* runs.due({ id: routine.id, botId: routine.bot_id });
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * A routine whose run could not be recorded is logged and looked at again
     * after a pause, a deadline stored on it, so a defect never repeats at once
     * and never holds up another routine. Only the deadline and trigger the
     * pass read are postponed: an edit committed since then stands. The new
     * deadline is the routine's next run, recorded as a change for clients.
     */
    const postpone = Effect.fn("Scheduler.postpone")(function* (ref: DueRef) {
      const at = DateTime.addDuration(yield* DateTime.now, DEFECT_RETRY);
      yield* transaction(
        Effect.gen(function* () {
          const moved = yield* postponed({ ...ref, at: timeText(at) });
          for (const routine of moved) {
            yield* changes.record({ _tag: "routines", botId: routine.bot_id }, routine.id);
          }
        }),
      ).pipe(Effect.orDie);
    });

    const pass = permit.withPermits(1)(
      Effect.gen(function* () {
        yield* transaction(runs.settle);
        const now = yield* DateTime.now;
        for (const ref of yield* dueRefs(timeText(now)).pipe(Effect.orDie)) {
          yield* start(ref).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logError(
                  "A routine's run could not be recorded; it is tried again later",
                  cause,
                ).pipe(Effect.andThen(postpone(ref))),
            ),
          );
        }
      }).pipe(Effect.withSpan("Scheduler.pass")),
    );

    /** How long to wait before the next pass, from the earliest next run. */
    const wait = Effect.gen(function* () {
      const row = yield* earliest(undefined).pipe(Effect.orDie);
      if (Option.isNone(row)) return HEARTBEAT;
      const now = yield* DateTime.now;
      return DateTime.isGreaterThan(row.value.next_run_at, now)
        ? Duration.min(HEARTBEAT, DateTime.distance(now, row.value.next_run_at))
        : // Due already: it came due while the pass ran, or its run could be
          // neither recorded nor postponed. Shortly, not at once, so a routine
          // that keeps failing does not keep the worker busy.
          RETRY_TICK;
    });

    // Anything that goes wrong in a round, the wait included, is logged and
    // the worker goes on after a pause: it never ends while the server runs.
    const loop = Effect.gen(function* () {
      const pause = yield* pass.pipe(
        Effect.andThen(wait),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.as(
              Effect.logError("The scheduler failed; it runs again later", cause),
              DEFECT_RETRY,
            ),
        ),
      );
      yield* Queue.take(nudges).pipe(Effect.timeoutOption(pause));
    }).pipe(Effect.forever, Effect.withSpan("The routine scheduler"));

    yield* Effect.forkScoped(loop);

    // In the transaction that changed a routine: once it commits, so the pass reads it.
    const nudge = sql.afterCommit(Queue.offer(nudges, undefined).pipe(Effect.asVoid));

    return Scheduler.of({ pass, nudge });
  }),
);
