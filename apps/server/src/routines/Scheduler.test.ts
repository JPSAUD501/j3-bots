// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { BotId, type Routine, RoutineId, type RoutineTrigger } from "@j3-bots/contracts";
import { SessionId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import type { ServerConfigShape } from "../config.ts";
import * as Domain from "../domain.ts";
import { homeLayout } from "../home/entries.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { timeText } from "../persistence/columns.ts";
import { migrate, migrationsThrough } from "../persistence/Migrations.ts";
import * as TestDatabase from "../testing/database.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createBot, eventually, noticesOf, until } from "../testing/turns.ts";
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
    assert.deepStrictEqual(
      (yield* wakesOf(routine.id)).map((wake) => wake.kind),
      ["routine"],
    );
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

/** A routine made while the server runs, then left with the server down: it runs only in `Domain.layer`. */
const madeBeforeDowntime = (trigger: RoutineTrigger) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    return yield* createRoutine(bot.id, trigger);
  }).pipe(Effect.provide(Domain.layer));

const hourly: RoutineTrigger = { _tag: "schedule", cron: "0 * * * *", timeZone: "UTC" };

it.effect(
  "makes up the latest run missed while the server was down, while it is nearer than the next",
  () =>
    Effect.gen(function* () {
      const routine = yield* madeBeforeDowntime(hourly);

      // Five hourly runs come due while the server is down; it is back 20 minutes after the last.
      yield* setTime("1970-01-01T05:20:00.000Z");

      yield* Effect.gen(function* () {
        yield* pass;
        yield* pass;
        const runs = yield* history(routine.id);
        assert.deepStrictEqual(
          runs.map((run) => [run.status, run.dueAt]),
          [["running", at("1970-01-01T05:00:00.000Z")]],
        );
        const after = yield* current(routine);
        assert.deepStrictEqual(after.nextRunAt, at("1970-01-01T06:00:00.000Z"));
        assert.strictEqual(after.missed, null);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "skips runs missed while the server was down once the next is nearer, and counts them until a run starts",
  () =>
    Effect.gen(function* () {
      const routine = yield* madeBeforeDowntime(hourly);

      // Back 40 minutes after the fifth missed run: the sixth is nearer.
      yield* setTime("1970-01-01T05:40:00.000Z");
      yield* Effect.gen(function* () {
        yield* pass;
        assert.deepStrictEqual(yield* history(routine.id), []);
        assert.deepStrictEqual(yield* wakesOf(routine.id), []);
        const after = yield* current(routine);
        assert.deepStrictEqual(after.nextRunAt, at("1970-01-01T06:00:00.000Z"));
        assert.deepStrictEqual(after.missed, {
          count: 5,
          since: at("1970-01-01T01:00:00.000Z"),
          until: at("1970-01-01T05:00:00.000Z"),
        });
      }).pipe(Effect.provide(Domain.layer));

      // Down again before 06:00, back at 08:45: three more are missed.
      yield* setTime("1970-01-01T08:45:00.000Z");
      yield* Effect.gen(function* () {
        yield* pass;
        assert.deepStrictEqual((yield* current(routine)).missed, {
          count: 8,
          since: at("1970-01-01T01:00:00.000Z"),
          until: at("1970-01-01T08:00:00.000Z"),
        });

        // The next run starts on time, which clears them.
        yield* setTime("1970-01-01T09:00:10.000Z");
        yield* pass;
        const runs = yield* history(routine.id);
        assert.deepStrictEqual(
          runs.map((run) => [run.status, run.dueAt]),
          [["running", undefined]],
        );
        assert.strictEqual((yield* current(routine)).missed, null);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("runs a one-time routine missed while the server was down, marked late", () =>
  Effect.gen(function* () {
    const routine = yield* madeBeforeDowntime({ _tag: "once", at: at("1970-01-01T01:00:00.000Z") });

    // A week later.
    yield* setTime("1970-01-08T01:00:00.000Z");
    yield* Effect.gen(function* () {
      yield* pass;
      const runs = yield* history(routine.id);
      assert.deepStrictEqual(
        runs.map((run) => [run.status, run.dueAt]),
        [["running", at("1970-01-01T01:00:00.000Z")]],
      );
      const after = yield* current(routine);
      assert.deepStrictEqual([after.enabled, after.nextRunAt, after.missed], [false, null, null]);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/** What the engine was sent for the routine's run, once its side session has it. */
const sentForRun = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const control = yield* TestEngineControl;
    const side = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ engine_session_id: SessionId }),
      execute: (id) => sql`
        SELECT s.engine_session_id FROM sessions s
        JOIN routine_runs r ON r.wake_id = s.side_wake_id
        WHERE r.routine_id = ${id} AND s.purpose = 'side' AND s.engine_session_id IS NOT NULL
      `,
    });
    return yield* eventually(
      side(routineId).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: ({ engine_session_id }) =>
              Effect.map(control.dispatches(engine_session_id), (sent) =>
                Option.fromNullishOr(sent[0]?.text),
              ),
          }),
        ),
      ),
    );
  });

it.effect("tells the bot the day a run was due when it starts just after that day ended", () =>
  Effect.gen(function* () {
    const routine = yield* madeBeforeDowntime({ _tag: "once", at: at("1970-01-01T23:59:45.000Z") });

    // Back 30 seconds after it, on the next day: not late, but "today" is no
    // longer the day it was due.
    yield* setTime("1970-01-02T00:00:15.000Z");
    yield* Effect.gen(function* () {
      yield* pass;
      assert.include(
        yield* sentForRun(routine.id),
        'due="1970-01-01T23:59:45+00:00" due-weekday="Thursday"',
      );
      // Clients do not show it as late.
      assert.deepStrictEqual(
        (yield* history(routine.id)).map((run) => run.dueAt),
        [undefined],
      );
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("forgets the runs a routine missed when it is given a new trigger", () =>
  Effect.gen(function* () {
    const routine = yield* madeBeforeDowntime(hourly);
    yield* setTime("1970-01-01T01:40:00.000Z");
    yield* Effect.gen(function* () {
      yield* pass;
      assert.strictEqual((yield* current(routine)).missed?.count, 1);
      const routines = yield* Routines;
      // Renamed, it still counts them; on another schedule, the old one's runs are gone.
      const renamed = yield* routines.update({
        commandId: command(),
        routineId: routine.id,
        changes: { name: "Hourly check" },
        author: operator,
      });
      assert.strictEqual(renamed.missed?.count, 1);
      const moved = yield* routines.update({
        commandId: command(),
        routineId: routine.id,
        changes: { trigger: { _tag: "schedule", cron: "30 * * * *", timeZone: "UTC" } },
        author: operator,
      });
      assert.strictEqual(moved.missed, null);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/**
 * What the release that ended with migration 20 left: an hourly routine that
 * ran at 00:00 and was due again at 01:00 when the server stopped.
 */
const writtenBeforeMissedRuns = (config: ServerConfigShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    yield* migrate(migrationsThrough(20));
    const midnight = "1970-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO bots (
        id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
        permission_mode, workspace_path, created_at, updated_at
      ) VALUES (
        'ana', 'Ana', '', 'dome', 'cobalt', '', ${TestDomain.DEFAULT_MODEL.providerId},
        ${TestDomain.DEFAULT_MODEL.modelId}, 'auto', ${homeLayout(path, config.home).workspace("ana")},
        ${midnight}, ${midnight}
      )
    `;
    yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('ana', ${midnight})`;
    yield* sql`
      INSERT INTO routines (
        id, bot_id, name, instruction, trigger_json, next_run_at, run_count, created_at, updated_at
      ) VALUES (
        'hourly', 'ana', 'Hourly check', 'Tell me what changed.',
        '{"_tag":"schedule","cron":"0 * * * *","timeZone":"UTC"}', '1970-01-01T01:00:00.000Z', 1,
        ${midnight}, ${midnight}
      )
    `;
    yield* sql`
      INSERT INTO routine_runs (id, routine_id, status, attempts, started_at, finished_at)
      VALUES ('run-1', 'hourly', 'silent', 1, '1970-01-01T00:00:01.000Z', '1970-01-01T00:01:00.000Z')
    `;
  });

it.effect("counts the runs a routine the last release saved missed while the server was down", () =>
  Effect.gen(function* () {
    // This release starts at 03:40.
    yield* setTime("1970-01-01T03:40:00.000Z");
    yield* Effect.gen(function* () {
      yield* pass;
      const [routine] = yield* (yield* Routines).list(BotId.make("ana"));
      assert.deepStrictEqual(routine?.missed, {
        count: 3,
        since: at("1970-01-01T01:00:00.000Z"),
        until: at("1970-01-01T03:00:00.000Z"),
      });
      assert.deepStrictEqual(routine?.nextRunAt, at("1970-01-01T04:00:00.000Z"));
      // Its run from before keeps no due time.
      assert.deepStrictEqual(
        (yield* history(RoutineId.make("hourly"))).map((run) => [run.status, run.dueAt]),
        [["silent", undefined]],
      );
    }).pipe(
      Effect.provide(
        TestDomain.layerOver(TestDatabase.layerAfter(writtenBeforeMissedRuns), new Map()),
      ),
    );
  }),
);

it.effect("runs nothing twice when the clock is set back past a run", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, hourly);
    yield* setTime("1970-01-01T01:00:05.000Z");
    yield* pass;

    // An hour back: the next run is still ahead, and nothing is due.
    yield* setTime("1970-01-01T00:10:00.000Z");
    yield* pass;
    assert.strictEqual((yield* history(routine.id)).length, 1);
    assert.deepStrictEqual((yield* current(routine)).nextRunAt, at("1970-01-01T02:00:00.000Z"));

    yield* setTime("1970-01-01T02:00:05.000Z");
    yield* pass;
    assert.deepStrictEqual(
      (yield* history(routine.id)).map((run) => run.dueAt),
      [undefined, undefined],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
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

      // Stopping the bot ends the run, which is not tried again: it ends as failed.
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
      yield* until(history(routine.id).pipe(Effect.map((runs) => runs[1]?.status === "failed")));
      const [, stopped] = yield* history(routine.id);
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
    // A database that refuses the run: recording it fails.
    yield* sql`
      CREATE TRIGGER refuse_runs BEFORE INSERT ON routine_runs
      BEGIN SELECT RAISE(ABORT, 'refused'); END
    `;
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

it.effect("pauses a routine whose trigger cannot be read, and tells clients and the operator", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* createRoutine(bot.id, {
      _tag: "schedule",
      cron: "10 * * * *",
      timeZone: "UTC",
    });
    const sql = yield* SqlClient.SqlClient;
    // A trigger this server cannot read, as one written by another version.
    yield* sql`UPDATE routines SET trigger_json = '{"_tag":"unknown"}' WHERE id = ${routine.id}`;
    const changes = yield* ChangeLog;
    const before = yield* changes.watermark;

    yield* setTime("1970-01-01T00:10:00.000Z");
    yield* pass;

    const resume = yield* changes.since({ _tag: "routines", botId: bot.id }, before);
    assert.deepStrictEqual(
      resume._tag === "changes" ? resume.changes.map((change) => change.entityId) : resume._tag,
      [routine.id],
    );
    const [row] = yield* sql<{
      readonly enabled: number;
      readonly next_run_at: string | null;
    }>`SELECT enabled, next_run_at FROM routines WHERE id = ${routine.id}`;
    assert.deepStrictEqual([row?.enabled, row?.next_run_at], [0, null]);
    assert.deepStrictEqual(yield* wakesOf(routine.id), []);
    assert.deepStrictEqual(yield* noticesOf(bot.id), ["routine-paused"]);
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

it.effect(
  "starts a one-time routine that ran again with a new trigger, and keeps an operator's pause",
  () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const routines = yield* Routines;
      const reminder = yield* createRoutine(bot.id, {
        _tag: "once",
        at: at("1970-01-01T00:10:00.000Z"),
      });
      const nightly = yield* createRoutine(bot.id, {
        _tag: "schedule",
        cron: "0 9 * * *",
        timeZone: "UTC",
      });
      yield* routines.update({
        commandId: command(),
        routineId: nightly.id,
        changes: { enabled: false },
        author: operator,
      });
      yield* setTime("1970-01-01T00:10:05.000Z");
      yield* pass;

      const again = yield* routines.update({
        commandId: command(),
        routineId: reminder.id,
        changes: { trigger: { _tag: "once", at: at("1970-01-01T01:00:00.000Z") } },
        author: operator,
      });
      assert.deepStrictEqual(
        [again.enabled, again.nextRunAt],
        [true, at("1970-01-01T01:00:00.000Z")],
      );
      const moved = yield* routines.update({
        commandId: command(),
        routineId: nightly.id,
        changes: { trigger: { _tag: "schedule", cron: "0 10 * * *", timeZone: "UTC" } },
        author: operator,
      });
      assert.deepStrictEqual([moved.enabled, moved.nextRunAt], [false, null]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("renames a one-time routine that ran through a change that sends its saved trigger", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routines = yield* Routines;
    const reminder = yield* createRoutine(bot.id, {
      _tag: "once",
      at: at("1970-01-01T00:10:00.000Z"),
    });
    yield* setTime("1970-01-01T00:10:05.000Z");
    yield* pass;

    // A form sends the whole draft: the trigger it sends is the saved one.
    const renamed = yield* routines.update({
      commandId: command(),
      routineId: reminder.id,
      changes: { name: "Dentist", trigger: reminder.trigger },
      author: operator,
    });
    assert.deepStrictEqual(
      [renamed.name, renamed.enabled, renamed.nextRunAt],
      ["Dentist", false, null],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a trigger that could never run, also on a paused routine", () =>
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
    yield* setTime("1970-01-01T00:10:00.000Z");

    const refused = (trigger: RoutineTrigger) =>
      routines
        .update({
          commandId: command(),
          routineId: routine.id,
          changes: { trigger },
          author: operator,
        })
        .pipe(Effect.flip);
    for (const trigger of [
      { _tag: "schedule", cron: "*/2 * * * *", timeZone: "UTC" },
      { _tag: "schedule", cron: "0 0 31 2 *", timeZone: "UTC" },
      { _tag: "once", at: at("1970-01-01T00:05:00.000Z") },
    ] satisfies ReadonlyArray<RoutineTrigger>) {
      const error = yield* refused(trigger);
      assert.deepStrictEqual(
        [error._tag, error._tag === "Invalid" && error.reason],
        ["Invalid", "schedule"],
      );
    }
    assert.deepStrictEqual((yield* current(routine)).trigger, routine.trigger);
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
    yield* until(
      history(routine.id).pipe(Effect.map((runs) => runs.every((run) => run.status !== "running"))),
    );
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
