// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, Routine, RoutineId } from "@j3-bots/contracts";
import { ENGINE_INPUT_LIMIT, Engine, SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  concurrentTurns,
  conversation,
  createBot,
  engineSession,
  eventually,
  flushed,
  holdGate,
  nextTurn,
  noticesOf,
  recoverTimes,
  sendToBot,
  stopSettled,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { MAX_INDETERMINATE_ANSWERS } from "../turns/model.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { Stops } from "../turns/Stops.ts";
import { RoutineRunner } from "./RoutineRunner.ts";
import { RoutineRuns, RUN_ATTEMPTS, retryDelay } from "./RoutineRuns.ts";
import { Routines } from "./Routines.ts";

const INSTRUCTION = "Check the open pull requests.";

/** A webhook routine of the bot. */
const routineOf = (botId: BotId) =>
  Effect.gen(function* () {
    return yield* (yield* Routines).create({
      commandId: command(),
      botId,
      draft: { name: "Pull requests", instruction: INSTRUCTION, trigger: { _tag: "webhook" } },
      author: { _tag: "operator" },
    });
  });

/** A webhook routine of a fresh bot, run once on demand. */
const ranRoutine = Effect.gen(function* () {
  const bot = yield* createBot("Ana");
  const routine = yield* routineOf(bot.id);
  yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
  return { bot, routine };
});

/** The routine's runs, newest first. */
const history = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const { runs } = yield* (yield* Routines).runs({ routineId, before: null, limit: 100 });
    return runs;
  });

/** Waits for the routine's newest run to settle, and returns it. */
const settled = (routine: Routine) =>
  eventually(
    history(routine.id).pipe(
      Effect.map((runs) =>
        Option.filter(Option.fromNullishOr(runs[0]), (run) => run.status !== "running"),
      ),
    ),
  );

const SideRow = Schema.Struct({
  engine_session_id: SessionId,
  admitted_turn_id: TurnId,
});

/**
 * Waits for the turn of the routine's latest attempt to run, in a side
 * session other than `previous`, and returns that session and turn.
 */
const sideTurn = (routineId: RoutineId, previous: SessionId | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SideRow,
      execute: (id) => sql`
        SELECT s.engine_session_id, s.admitted_turn_id FROM sessions s
        JOIN routine_runs r ON r.wake_id = s.side_wake_id
        WHERE r.routine_id = ${id} AND s.purpose = 'side' AND s.retired_at IS NULL
          AND s.lost_at IS NULL AND s.engine_session_id IS NOT NULL
          AND s.admitted_turn_id IS NOT NULL
      `,
    });
    return yield* eventually(
      find(routineId).pipe(
        Effect.orDie,
        Effect.map(Option.filter((row) => row.engine_session_id !== previous)),
      ),
    );
  });

/** Whether the server recorded every side session of the bot retired. */
const sidesRetired = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM sessions
      WHERE bot_id = ${botId} AND purpose = 'side' AND retired_at IS NULL
    `.pipe(Effect.orDie);
    return (row?.n ?? 0) === 0;
  });

/** What the bot said in its conversation, oldest first. */
const botSaid = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry._tag === "message" && entry.author._tag === "bot" ? [entry.text] : [],
      ),
    ),
  );

const failed = { _tag: "failed", failure: "provider-error", retryAt: null } as const;

/** The engine sessions of the bot's side sessions opened so far, oldest first. */
const sideSessions = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ engine_session_id: SessionId }),
      execute: (id) => sql`
        SELECT engine_session_id FROM sessions
        WHERE bot_id = ${id} AND purpose = 'side' AND engine_session_id IS NOT NULL
        ORDER BY rowid
      `,
    })(botId).pipe(Effect.orDie);
    return rows.map((row) => row.engine_session_id);
  });

/** Waits for a turn of the engine session other than `previous` to be running. */
const admittedIn = (sessionId: SessionId, previous: TurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ admitted_turn_id: TurnId }),
      execute: (id) => sql`
        SELECT admitted_turn_id FROM sessions
        WHERE engine_session_id = ${id} AND admitted_turn_id IS NOT NULL
      `,
    });
    const row = yield* eventually(
      find(sessionId).pipe(
        Effect.orDie,
        Effect.map(Option.filter((found) => found.admitted_turn_id !== previous)),
      ),
    );
    return row.admitted_turn_id;
  });

/** Waits until the routine's run waits to try again, with a new wake. */
const retryRecorded = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* until(
      sql`
        SELECT 1 FROM wakes
        WHERE routine_id = ${routineId} AND status = 'pending' AND retry_of IS NOT NULL
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    );
  });

/** The bot says `text` in the turn, through the `say` tool. */
const say = (sessionId: SessionId, turnId: TurnId, text: string, requestId: string) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "say",
      input: { text },
      recorded: "now",
    });
    yield* (yield* BotTools).call({ requestId, sessionId, tool: "say", arguments: { text } });
  });

it.effect(
  "runs a routine in a side session, settles it delivered when the bot speaks, and tells the main session",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, routine } = yield* ranRoutine;
      const main = yield* engineSession(bot.id);
      const side = yield* sideTurn(routine.id);

      assert.notStrictEqual(side.engine_session_id, main);
      assert.strictEqual(yield* timesSent(side.engine_session_id, INSTRUCTION), 1);
      assert.strictEqual(yield* timesSent(main, INSTRUCTION), 0);

      const text = "Two pull requests wait for a review.";
      yield* control.toolCall({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
        tool: "say",
        input: { text },
        recorded: "now",
      });
      yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: side.engine_session_id,
        tool: "say",
        arguments: { text },
      });
      yield* control.finishTurn({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
        outcome: { _tag: "completed" },
      });

      const run = yield* settled(routine);
      assert.strictEqual(run.status, "delivered");
      assert.strictEqual(run.attempts, 1);
      assert.strictEqual(run.delivered.length, 1);
      assert.deepStrictEqual(yield* botSaid(bot.id), [text]);
      yield* until(sidesRetired(bot.id));

      // The main session did not see the run: its next envelope tells it.
      yield* sendToBot(bot.id, "Anything new?");
      yield* until(timesSent(main, "Anything new?").pipe(Effect.map((n) => n === 1)));
      assert.strictEqual(yield* timesSent(main, text), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("settles a run that ends without speaking as silent, and shows nothing", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, routine } = yield* ranRoutine;
    const side = yield* sideTurn(routine.id);

    yield* control.finishTurn({
      sessionId: side.engine_session_id,
      turnId: side.admitted_turn_id,
      outcome: { _tag: "completed" },
    });

    const run = yield* settled(routine);
    assert.deepStrictEqual([run.status, run.delivered], ["silent", []]);
    yield* until(sidesRetired(bot.id));
    assert.deepStrictEqual(yield* botSaid(bot.id), []);
    assert.deepStrictEqual(yield* noticesOf(bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "tries a failed attempt again in a fresh side session after a delay, and fails the run after the last",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, routine } = yield* ranRoutine;

      let previous: SessionId | null = null;
      for (let attempt = 1; attempt <= RUN_ATTEMPTS; attempt++) {
        const side: typeof SideRow.Type = yield* sideTurn(routine.id, previous);
        previous = side.engine_session_id;
        yield* control.finishTurn({
          sessionId: side.engine_session_id,
          turnId: side.admitted_turn_id,
          outcome: failed,
        });
        if (attempt === RUN_ATTEMPTS) break;
        // The next attempt is recorded and waits for its delay, not started yet.
        yield* retryRecorded(routine.id);
        const [run] = yield* history(routine.id);
        assert.deepStrictEqual([run?.status, run?.attempts], ["running", attempt]);
        yield* TestClock.adjust(retryDelay(attempt));
      }

      const run = yield* settled(routine);
      assert.deepStrictEqual([run.status, run.attempts], ["failed", RUN_ATTEMPTS]);
      yield* until(sidesRetired(bot.id));
      // A routine's failure is in its run history, not in the conversation.
      assert.deepStrictEqual(yield* noticesOf(bot.id), []);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a run the operator stopped as failed, without another attempt", () =>
  Effect.gen(function* () {
    const { bot, routine } = yield* ranRoutine;
    yield* sideTurn(routine.id);

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* stopSettled;

    const run = yield* settled(routine);
    assert.deepStrictEqual([run.status, run.attempts], ["failed", 1]);
    yield* until(sidesRetired(bot.id));
    const sql = yield* SqlClient.SqlClient;
    const pending = yield* sql`
      SELECT 1 FROM wakes WHERE routine_id = ${routine.id} AND status = 'pending'
    `.pipe(Effect.orDie);
    assert.strictEqual(pending.length, 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "tags what a run says in a turn its background work started, and tells the main session",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, routine } = yield* ranRoutine;
      const main = yield* engineSession(bot.id);
      const side = yield* sideTurn(routine.id);
      yield* control.startBackgroundWork({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
      });
      yield* control.finishTurn({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
        outcome: { _tag: "completed" },
      });
      assert.strictEqual((yield* settled(routine)).status, "silent");

      // The work ends and wakes the side session, and the bot reports on it.
      yield* control.startEngineTurn(side.engine_session_id);
      const later = yield* admittedIn(side.engine_session_id, side.admitted_turn_id);
      const text = "The nightly build passed.";
      yield* say(side.engine_session_id, later, text, "call-1");

      const run = yield* eventually(
        history(routine.id).pipe(
          Effect.map((runs) =>
            Option.filter(Option.fromNullishOr(runs[0]), (r) => r.delivered.length > 0),
          ),
        ),
      );
      assert.strictEqual(run.status, "delivered");
      yield* sendToBot(bot.id, "Anything new?");
      yield* until(timesSent(main, "Anything new?").pipe(Effect.map((n) => n === 1)));
      assert.strictEqual(yield* timesSent(main, text), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a question card in a routine's turn, which nobody could answer", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, routine } = yield* ranRoutine;
    const side = yield* sideTurn(routine.id);
    const args = { prompt: "Merge it?", options: [{ label: "Yes" }, { label: "No" }] };

    yield* control.toolCall({
      sessionId: side.engine_session_id,
      turnId: side.admitted_turn_id,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    const reply = yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: side.engine_session_id,
      tool: "ask",
      arguments: args,
    });
    assert.strictEqual(reply._tag, "refused");
    const shown = yield* conversation(bot.id);
    assert.isFalse(shown.some((entry) => entry._tag === "question"));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("fails a run whose envelope the engine could never take, without another attempt", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* routineOf(bot.id);
    const sql = yield* SqlClient.SqlClient;
    const { webhook_secret: secret } = yield* SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ webhook_secret: Schema.String }),
      execute: (id) => sql`SELECT webhook_secret FROM routines WHERE id = ${id}`,
    })(routine.id).pipe(Effect.orDie);
    yield* (yield* RoutineRuns).webhook({
      routineId: routine.id,
      secret,
      body: "x".repeat(ENGINE_INPUT_LIMIT),
      requestKey: null,
    });

    const run = yield* settled(routine);
    assert.deepStrictEqual([run.status, run.attempts], ["failed", 1]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts only the attempts that started when a Stop ends a run waiting to try again", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, routine } = yield* ranRoutine;
    const side = yield* sideTurn(routine.id);
    yield* control.finishTurn({
      sessionId: side.engine_session_id,
      turnId: side.admitted_turn_id,
      outcome: failed,
    });
    yield* retryRecorded(routine.id);

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* stopSettled;

    const run = yield* settled(routine);
    assert.deepStrictEqual([run.status, run.attempts], ["failed", 1]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("deletes a bot after one of its routines ran", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, routine } = yield* ranRoutine;
    const side = yield* sideTurn(routine.id);
    yield* control.finishTurn({
      sessionId: side.engine_session_id,
      turnId: side.admitted_turn_id,
      outcome: { _tag: "completed" },
    });
    yield* settled(routine);
    yield* until(sidesRetired(bot.id));

    yield* (yield* Bots).remove({ commandId: command(), botId: bot.id, deleteFiles: false });
    assert.isTrue(Option.isNone(yield* (yield* BotStore).find(bot.id)));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "records a side session retired that the engine archived without the server knowing",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, routine } = yield* ranRoutine;
      const side = yield* sideTurn(routine.id);
      // Work the run left running keeps its session in use.
      yield* control.startBackgroundWork({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
      });
      yield* control.finishTurn({
        sessionId: side.engine_session_id,
        turnId: side.admitted_turn_id,
        outcome: { _tag: "completed" },
      });
      yield* settled(routine);

      // The engine archived it, and the server never learned: its answer was lost.
      yield* (yield* Engine).retireSession(side.engine_session_id);
      yield* (yield* RoutineRunner).pass;

      yield* until(sidesRetired(bot.id));
      const sql = yield* SqlClient.SqlClient;
      const lost = yield* sql`
      SELECT 1 FROM sessions WHERE engine_session_id = ${side.engine_session_id}
        AND lost_at IS NOT NULL
    `.pipe(Effect.orDie);
      assert.strictEqual(lost.length, 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts a retry only once the attempt whose answer was lost is out of use", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const deferred = yield* control.deferNextDispatch;
    const { bot, routine } = yield* ranRoutine;

    // The attempt's send is never answered, and its recovery gives up.
    yield* until(
      sql<{ readonly n: number }>`
        SELECT d.indeterminate_answers AS n FROM dispatches d
        JOIN sessions s ON s.id = d.session_id WHERE s.purpose = 'side'
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      ),
    );
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    const [old] = yield* sideSessions(bot.id);
    assert.isDefined(old);

    // A turn of the engine's own keeps that session busy; the run is retried.
    const busy = yield* control.startEngineTurn(old);
    yield* retryRecorded(routine.id);
    // The engine applies the lost send after all, behind that turn.
    yield* deferred.land;

    yield* TestClock.adjust(retryDelay(1));
    yield* (yield* RoutineRunner).pass;
    assert.deepStrictEqual(yield* sideSessions(bot.id), [old]);

    // Once the late attempt ends and its session is retired, the retry starts.
    yield* control.finishTurn({ sessionId: old, turnId: busy, outcome: { _tag: "completed" } });
    const late = yield* admittedIn(old, busy);
    yield* control.finishTurn({ sessionId: old, turnId: late, outcome: { _tag: "completed" } });
    yield* sideTurn(routine.id, old);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("gives a contended turn slot to the operator's message before a routine's start", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* concurrentTurns(2);
    const cara = yield* createBot("Cara");
    const dan = yield* createBot("Dan");
    yield* flushed(cara.id);
    yield* flushed(dan.id);

    // The dispatcher's pass waits on Cara's send while a routine's start is written.
    const held = yield* holdGate(cara.id);
    yield* sendToBot(cara.id, "Plan the sprint.");
    const { bot } = yield* ranRoutine;
    yield* until(
      sql`
        SELECT 1 FROM dispatches d JOIN sessions s ON s.id = d.session_id
        WHERE s.purpose = 'side'
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    );
    yield* sendToBot(dan.id, "Review the budget.");
    yield* held.release;

    // Cara's turn takes one slot. Dan's message takes the last one.
    yield* nextTurn(cara.id);
    yield* nextTurn(dan.id);
    yield* (yield* Pipeline).dispatchPending;
    const [side] = yield* sideSessions(bot.id);
    assert.isDefined(side);
    assert.strictEqual(yield* timesSent(side, INSTRUCTION), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds a run while its provider is at its usage limit, until the reset", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const main = yield* engineSession(bot.id);

    // The bot's last turn met its provider's usage limit, which resets in an hour.
    yield* sendToBot(bot.id, "Plan the sprint.");
    const turn = yield* nextTurn(bot.id);
    const resetsAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
    yield* control.finishTurn({
      sessionId: main,
      turnId: turn,
      outcome: { _tag: "failed", failure: "usage-limit", retryAt: resetsAt },
    });
    yield* turnEnded(bot.id);

    const routine = yield* routineOf(bot.id);
    yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
    yield* (yield* RoutineRunner).pass;
    assert.deepStrictEqual(yield* sideSessions(bot.id), []);

    yield* TestClock.adjust(Duration.hours(1));
    yield* sideTurn(routine.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);
