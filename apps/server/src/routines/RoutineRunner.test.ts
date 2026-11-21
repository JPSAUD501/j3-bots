// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, Routine, RoutineId } from "@j3-bots/contracts";
import { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  eventually,
  noticesOf,
  sendToBot,
  stopSettled,
  timesSent,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Stops } from "../turns/Stops.ts";
import { RUN_ATTEMPTS, retryDelay } from "./RoutineRuns.ts";
import { Routines } from "./Routines.ts";

const INSTRUCTION = "Check the open pull requests.";

/** A webhook routine of a fresh bot, run once on demand. */
const ranRoutine = Effect.gen(function* () {
  const bot = yield* createBot("Ana");
  const routines = yield* Routines;
  const routine = yield* routines.create({
    commandId: command(),
    botId: bot.id,
    draft: { name: "Pull requests", instruction: INSTRUCTION, trigger: { _tag: "webhook" } },
    author: { _tag: "operator" },
  });
  yield* routines.run({ commandId: command(), routineId: routine.id });
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

/** Whether every side session of the bot was taken out of use, in the server and the engine. */
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
        // The next attempt is recorded and waits for its delay.
        yield* until(
          history(routine.id).pipe(Effect.map((runs) => runs[0]?.attempts === attempt + 1)),
        );
        assert.strictEqual((yield* history(routine.id))[0]?.status, "running");
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
