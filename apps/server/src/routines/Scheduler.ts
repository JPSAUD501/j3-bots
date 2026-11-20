// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoutineId, RoutineTrigger } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
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

const Due = Schema.Struct({
  id: RoutineId,
  bot_id: BotId,
  trigger_json: json(RoutineTrigger),
});

const Named = Schema.Struct({ id: RoutineId });

/**
 * The routine scheduler (`docs/architecture/server.md`, Routines), a worker
 * over durable state like the turn machinery's. A pass settles the runs whose
 * wakes ended, then records a run of every enabled routine whose next run has
 * come, in the transaction that moves it on to the run after: a schedule to
 * its next time after now, a one-time trigger to paused. Runs missed while the
 * server was down are therefore not replayed: a routine that missed any runs
 * once when the server is back, and goes on from there. The worker looks again
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
    const nudges = yield* Queue.sliding<void>(1);
    const permit = yield* Semaphore.make(1);

    const dueRows = (now: DateTime.Utc) =>
      sql`
        SELECT id, bot_id, trigger_json FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${timeText(now)}
        ORDER BY next_run_at, id
      `.pipe(Effect.orDie);

    const earliest = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ next_run_at: Time }),
      execute: () => sql`
        SELECT MIN(next_run_at) AS next_run_at FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL
      `,
    })(undefined).pipe(Effect.orDie);

    /**
     * Records the run of one routine that came due and moves it on, in one
     * transaction, if it is still due: a change committed since the pass read
     * it wins.
     */
    const start = Effect.fn("Scheduler.start")(function* (routine: typeof Due.Type) {
      yield* transaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const still = yield* sql`
            SELECT 1 FROM routines
            WHERE id = ${routine.id} AND enabled = 1 AND next_run_at <= ${timeText(now)}
          `;
          if (still.length === 0) return;
          const trigger = routine.trigger_json;
          const next = nextRun(trigger, now);
          if (Result.isFailure(next)) {
            // Saved schedules parse; one that stops parsing (a zone the
            // runtime no longer knows) runs this once and then waits for an edit.
            yield* Effect.logWarning("A routine's schedule cannot be read; it stops", {
              routineId: routine.id,
              reason: next.failure.reason,
            });
          }
          const after = Result.isSuccess(next) ? Option.getOrNull(next.success) : null;
          yield* sql`
            UPDATE routines SET
              next_run_at = ${after === null ? null : timeText(after)},
              enabled = ${trigger._tag === "once" ? 0 : 1},
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
     * and never holds up another routine.
     */
    const postpone = Effect.fn("Scheduler.postpone")(function* (routineId: RoutineId) {
      const at = DateTime.addDuration(yield* DateTime.now, DEFECT_RETRY);
      yield* sql`
        UPDATE routines SET next_run_at = ${timeText(at)} WHERE id = ${routineId} AND enabled = 1
      `.pipe(Effect.orDie);
    });

    const supervised = (routineId: RoutineId | null, effect: Effect.Effect<void>) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError(
              "A routine's run could not be recorded; it is tried again later",
              cause,
            ).pipe(Effect.andThen(routineId === null ? Effect.void : postpone(routineId))),
        ),
      );

    const pass = permit.withPermits(1)(
      Effect.gen(function* () {
        yield* transaction(runs.settle);
        const now = yield* DateTime.now;
        for (const raw of yield* dueRows(now)) {
          const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(Due)(raw));
          if (Exit.isSuccess(decoded)) {
            yield* supervised(decoded.value.id, start(decoded.value));
            continue;
          }
          const named = Schema.decodeUnknownOption(Named)(raw);
          yield* supervised(
            Option.isSome(named) ? named.value.id : null,
            Effect.logError("A routine could not be read", decoded.cause),
          );
        }
      }).pipe(Effect.withSpan("Scheduler.pass")),
    );

    /** How long to wait before the next pass, from the earliest next run. */
    const wait = Effect.gen(function* () {
      const [row] = yield* earliest;
      if (row === undefined) return HEARTBEAT;
      const now = yield* DateTime.now;
      return DateTime.isGreaterThan(row.next_run_at, now)
        ? Duration.min(HEARTBEAT, DateTime.distance(now, row.next_run_at))
        : // Due already and not recorded by this pass: postponed or changing.
          RETRY_TICK;
    });

    const loop = Effect.gen(function* () {
      const failed = yield* pass.pipe(
        Effect.andThen(Effect.succeed(false)),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.as(Effect.logError("The scheduler failed; it runs again later", cause), true),
        ),
      );
      const pause = failed ? DEFECT_RETRY : yield* wait;
      yield* Queue.take(nudges).pipe(Effect.timeoutOption(pause));
    }).pipe(Effect.forever, Effect.withSpan("The routine scheduler"));

    yield* Effect.forkScoped(loop);

    // In the transaction that changed a routine: once it commits, so the pass reads it.
    const nudge = sql.afterCommit(Queue.offer(nudges, undefined).pipe(Effect.asVoid));

    return Scheduler.of({ pass, nudge });
  }),
);
