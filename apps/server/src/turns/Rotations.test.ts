// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  deliveryIs,
  engineSession,
  mainSessionId,
  nextTurn,
  sendToBot,
  sessionAfter,
  timesSent,
  turnEnded,
} from "../testing/turns.ts";
import { Rotations, ROTATE_AFTER_RUNS } from "./Rotations.ts";
import { Usage } from "./Usage.ts";

/** The operator writes, the bot answers in host speech, and its turn completes. */
const exchange = (botId: BotId, session: SessionId, text: string, answer: string) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* sendToBot(botId, text);
    const turnId = yield* nextTurn(botId);
    yield* control.hostSpeech({ sessionId: session, turnId, text: answer });
    yield* finish(botId, session, turnId);
    return turnId;
  });

const finish = (botId: BotId, session: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(botId);
  });

/** Whether the server took the session out of use in the engine. */
const retiredInEngine = (session: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* Rotations).rotateDue;
    const rows = yield* sql<{ readonly engine_retired_at: string | null }>`
      SELECT engine_retired_at FROM sessions WHERE engine_session_id = ${session}
    `;
    return rows[0]?.engine_retired_at !== null;
  });

it.effect("starts a bot fresh in a new session that the next message reaches with a digest", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* exchange(bot.id, session, "Plan the launch.", "Drafted it in files/launch.md.");

    yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
    const replacement = yield* sessionAfter(bot.id, session);
    assert.isTrue(yield* retiredInEngine(session));

    const message = yield* sendToBot(bot.id, "And the budget?");
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "And the budget?"), 0);
    const [first] = yield* control.dispatches(replacement);
    const text = first?.text ?? "";
    assert.include(text, "Your working session was replaced.");
    assert.include(text, "Plan the launch.");
    assert.include(text, "You: Drafted it in files/launch.md.");
    // The message itself arrives once, as the message, not in the digest too.
    assert.strictEqual(text.split("And the budget?").length - 1, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("replaces a session only once nothing runs in it, holding new work meanwhile", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Back up the database.");
    const running = yield* nextTurn(bot.id);

    yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
    const waiting = yield* sendToBot(bot.id, "Then the logs.");
    yield* (yield* Rotations).rotateDue;
    assert.strictEqual(yield* engineSession(bot.id), session);
    yield* deliveryIs(waiting, "pending");

    yield* finish(bot.id, session, running);
    const replacement = yield* sessionAfter(bot.id, session);
    yield* nextTurn(bot.id);
    yield* deliveryIs(waiting, "delivered");
    assert.strictEqual(yield* timesSent(replacement, "Then the logs."), 1);
    assert.strictEqual(yield* timesSent(session, "Then the logs."), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("replaces a session whose provider conversation the engine could not resume", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Where were we?");
    const turnId = yield* nextTurn(bot.id);
    yield* control.recoverContext({ sessionId: session, turnId });
    yield* finish(bot.id, session, turnId);

    yield* sessionAfter(bot.id, session);
    assert.isTrue(yield* retiredInEngine(session));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "moves a bot to another provider in a new session, and another model in the same one",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const before = yield* mainSessionId(bot.id);

      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });
      yield* (yield* Rotations).rotateDue;
      assert.strictEqual(yield* mainSessionId(bot.id), before);

      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
      });
      yield* sessionAfter(bot.id, session);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly provider_id: string }>`
      SELECT provider_id FROM sessions WHERE id = ${yield* mainSessionId(bot.id)}
    `;
      assert.strictEqual(row?.provider_id, TestDomain.OTHER_PROVIDER_MODEL.providerId);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("replaces a session that reached its run limit", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const id = yield* mainSessionId(bot.id);
    const at = DateTime.formatIso(yield* DateTime.now);
    // Turns long finished: what a session that ran for weeks has recorded.
    for (let n = 0; n < ROTATE_AFTER_RUNS; n++) {
      yield* sql`
        INSERT INTO turns (
          session_id, engine_turn_id, audience, started_at, last_activity_at, finished_at,
          outcome_json
        ) VALUES (${id}, ${`old-${n}`}, 'conversation', ${at}, ${at}, ${at}, '{"_tag":"completed"}')
      `;
    }
    yield* (yield* Rotations).rotateDue;
    yield* sessionAfter(bot.id, session);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("reports each turn with its bot and provider, newest first", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const since = yield* DateTime.now;
    yield* TestClock.adjust("1 second");
    yield* exchange(ana.id, anaSession, "First.", "One.");
    const bia = yield* createBot("Bia");
    const biaFirst = yield* engineSession(bia.id);
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bia.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });
    const biaSession = yield* sessionAfter(bia.id, biaFirst);
    yield* TestClock.adjust("1 second");
    yield* exchange(bia.id, biaSession, "Second.", "Two.");

    const usage = yield* Usage;
    const page = yield* usage.turns({ since, limit: 1 });
    assert.isTrue(page.hasMore);
    const all = yield* usage.turns({ since, limit: 10 });
    assert.isFalse(all.hasMore);
    // Each turn ran on its bot's provider then, newest first: Bia's last.
    // An `undelivered` follow-up of either may be among them.
    const providerOf = new Map<string, string>([
      [ana.id, "claude"],
      [bia.id, TestDomain.OTHER_PROVIDER_MODEL.providerId],
    ]);
    assert.strictEqual(all.turns[0]?.botId, bia.id);
    assert.includeMembers(
      all.turns.map((turn) => turn.botId),
      [ana.id, bia.id],
    );
    for (const turn of all.turns) assert.strictEqual(turn.providerId, providerOf.get(turn.botId));
    const starts = all.turns.map((turn) => DateTime.toEpochMillis(turn.startedAt));
    assert.deepStrictEqual(
      starts,
      starts.toSorted((a, b) => b - a),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);
