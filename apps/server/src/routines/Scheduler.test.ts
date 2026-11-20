// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, Routine, RoutineId, RoutineTrigger } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createBot } from "../testing/turns.ts";
import { Stops } from "../turns/Stops.ts";
import { RUN_HISTORY } from "./RoutineRuns.ts";
import { Routines } from "./Routines.ts";
import { Scheduler } from "./Scheduler.ts";

// The test clock starts at the epoch and is only ever moved forward a little:
// every worker's heartbeat runs at each minute it passes.
const at = (iso: string) => DateTime.makeUnsafe(iso);
const setTime = (iso: string) => TestClock.setTime(at(iso).epochMilliseconds);

const operator = { _tag: "operator" } as const;

const createRoutine = (botId: BotId, trigger: RoutineTrigger) =>
  Effect.gen(function* () {
    const routines = yield* Routines;
    return yield* routines.create({
      commandId: command(),
      botId,
      draft: { name: "Morning check", instruction: "Tell me what changed.", trigger },
      author: operator,
    });
  });

/** The routine as the operator sees it now. */
const current = (routine: Routine) =>
  Effect.gen(function* () {
    const found = (yield* (yield* Routines).list(routine.botId)).find(
      (candidate) => candidate.id === routine.id,
    );
    if (found === undefined) return yield* Effect.die("The routine is gone");
    return found;
  });

/** The routine's runs, newest first. */
const history = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const routines = yield* Routines;
    const { runs } = yield* routines.runs({ routineId, before: null, limit: 1_000 });
    return runs;
  });

const wakesOf = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ kind: Schema.String, status: Schema.String }),
      execute: (id) => sql`SELECT kind, status FROM wakes WHERE routine_id = ${id} ORDER BY rowid`,
    })(routineId).pipe(Effect.orDie);
  });

const pass = Effect.gen(function* () {
  yield* (yield* Scheduler).pass;
});

it.effect("records a run that came due with its routine wake, and moves on to the next run", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, {
      _tag: "schedule",
      cron: "10 9 * * *",
      timeZone: "Asia/Tokyo",
    });
    // The epoch is 09:00 in Tokyo.
    assert.deepStrictEqual(routine.nextRunAt, at("1970-01-01T00:10:00.000Z"));

    yield* setTime("1970-01-01T00:10:30.000Z");
    yield* pass;

    const runs = yield* history(routine.id);
    assert.deepStrictEqual(
      runs.map((run) => [run.status, run.finishedAt]),
      [["running", null]],
    );
    assert.deepStrictEqual(yield* wakesOf(routine.id), [{ kind: "routine", status: "pending" }]);
    const after = yield* current(routine);
    assert.deepStrictEqual(after.nextRunAt, at("1970-01-02T00:10:00.000Z"));
    assert.strictEqual(after.runCount, 1);
    assert.strictEqual(after.lastRun?.id, runs[0]?.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("runs the first schedule of a fresh install on its own, at its time", () =>
  Effect.gen(function* () {
    // The worker starts with no routine at all, and nothing here calls a pass.
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, {
      _tag: "schedule",
      cron: "10 * * * *",
      timeZone: "UTC",
    });
    yield* TestClock.adjust("11 minutes");
    assert.deepStrictEqual(
      (yield* history(routine.id)).map((run) => run.status),
      ["running"],
    );
    assert.deepStrictEqual((yield* current(routine)).nextRunAt, at("1970-01-01T01:10:00.000Z"));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "runs a routine that missed runs while the server was down once, then keeps its schedule",
  () =>
    Effect.gen(function* () {
      const routine = yield* Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        return yield* createRoutine(bot.id, {
          _tag: "schedule",
          cron: "0 * * * *",
          timeZone: "UTC",
        });
      }).pipe(Effect.provide(Domain.layer));

      // Five hourly runs come due while the server is down.
      yield* setTime("1970-01-01T05:20:00.000Z");

      yield* Effect.gen(function* () {
        yield* pass;
        yield* pass;
        assert.strictEqual((yield* history(routine.id)).length, 1);
        assert.deepStrictEqual((yield* current(routine)).nextRunAt, at("1970-01-01T06:00:00.000Z"));
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "skips a run that comes due while the previous one is going, and runs again once it ended",
  () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const routine = yield* createRoutine(bot.id, {
        _tag: "schedule",
        cron: "*/10 * * * *",
        timeZone: "UTC",
      });
      yield* setTime("1970-01-01T00:10:10.000Z");
      yield* pass;

      yield* setTime("1970-01-01T00:20:10.000Z");
      yield* pass;
      assert.deepStrictEqual(
        (yield* history(routine.id)).map((run) => run.status),
        ["skipped", "running"],
      );
      // Only the run that ran counts.
      assert.strictEqual((yield* current(routine)).runCount, 1);

      // Stopping the bot cancels the wake still waiting: the run ends as failed.
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
      yield* pass;
      const [, stopped] = yield* history(routine.id);
      assert.strictEqual(stopped?.status, "failed");
      assert.notStrictEqual(stopped?.finishedAt, null);

      yield* TestClock.adjust("1 second");
      yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
      assert.deepStrictEqual(
        (yield* history(routine.id)).map((run) => run.status),
        ["running", "skipped", "failed"],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("tells clients of the later try when a routine's run cannot be recorded", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, {
      _tag: "schedule",
      cron: "10 * * * *",
      timeZone: "UTC",
    });
    const sql = yield* SqlClient.SqlClient;
    // A trigger the scheduler cannot read: recording the run fails.
    yield* sql`UPDATE routines SET trigger_json = '{"_tag":"unknown"}' WHERE id = ${routine.id}`;
    const changes = yield* ChangeLog;
    const before = yield* changes.watermark;

    yield* setTime("1970-01-01T00:10:00.000Z");
    yield* pass;

    // Tried again 30 seconds later, which clients are told.
    const resume = yield* changes.since({ _tag: "routines", botId: bot.id }, before);
    assert.deepStrictEqual(
      resume._tag === "changes" ? resume.changes.map((change) => change.entityId) : resume._tag,
      [routine.id],
    );
    const [row] = yield* sql<{
      readonly next_run_at: string;
    }>`SELECT next_run_at FROM routines WHERE id = ${routine.id}`;
    assert.strictEqual(row?.next_run_at, timeText(at("1970-01-01T00:10:30.000Z")));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("runs a one-time routine once and pauses it", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, {
      _tag: "once",
      at: at("1970-01-01T00:10:00.000Z"),
    });

    yield* setTime("1970-01-01T00:10:05.000Z");
    yield* pass;
    yield* setTime("1970-01-01T00:20:05.000Z");
    yield* pass;

    assert.strictEqual((yield* history(routine.id)).length, 1);
    const after = yield* current(routine);
    assert.strictEqual(after.enabled, false);
    assert.strictEqual(after.nextRunAt, null);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("runs a paused routine on demand without resuming it", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routines = yield* Routines;
    const routine = yield* createRoutine(bot.id, {
      _tag: "schedule",
      cron: "0 9 * * *",
      timeZone: "UTC",
    });
    yield* routines.update({
      commandId: command(),
      routineId: routine.id,
      changes: { enabled: false },
      author: operator,
    });

    const run = command();
    yield* routines.run({ commandId: run, routineId: routine.id });
    // A retried command is the same run.
    yield* routines.run({ commandId: run, routineId: routine.id });

    assert.deepStrictEqual(
      (yield* history(routine.id)).map((one) => one.status),
      ["running"],
    );
    const after = yield* current(routine);
    assert.strictEqual(after.enabled, false);
    assert.strictEqual(after.nextRunAt, null);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a routine's newest settled runs and the one going", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routines = yield* Routines;
    const routine = yield* createRoutine(bot.id, { _tag: "webhook" });

    for (let n = 0; n < RUN_HISTORY + 5; n++) {
      yield* TestClock.adjust("1 second");
      yield* routines.run({ commandId: command(), routineId: routine.id });
    }

    const runs = yield* history(routine.id);
    assert.strictEqual(runs.length, RUN_HISTORY + 1);
    // The run going is the oldest; the first skipped ones are gone.
    assert.strictEqual(runs.at(-1)?.status, "running");
    assert.deepStrictEqual(runs.at(-2)?.startedAt, at("1970-01-01T00:00:07.000Z"));

    // Once the run going settles it is a settled run too, and the cap still holds.
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* pass;
    assert.strictEqual((yield* history(routine.id)).length, RUN_HISTORY);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels the wake of a run still waiting when its routine is deleted", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routines = yield* Routines;
    const routine = yield* createRoutine(bot.id, { _tag: "webhook" });
    yield* routines.run({ commandId: command(), routineId: routine.id });

    const sql = yield* SqlClient.SqlClient;
    const [wake] = yield* sql<{
      readonly id: string;
    }>`SELECT id FROM wakes WHERE routine_id = ${routine.id}`;
    yield* routines.remove({ commandId: command(), routineId: routine.id, author: operator });

    const [after] = yield* sql<{
      readonly status: string;
    }>`SELECT status FROM wakes WHERE id = ${wake?.id ?? ""}`;
    assert.strictEqual(after?.status, "cancelled");
  }).pipe(Effect.provide(TestDomain.layer)),
);
