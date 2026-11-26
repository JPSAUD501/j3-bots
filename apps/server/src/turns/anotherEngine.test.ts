// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import type { SessionId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDomain from "../testing/domain.ts";
import {
  createBot,
  deliveryIs,
  engineSession,
  nextTurn,
  noticesOf,
  sendToBot,
  sessionAfter,
  until,
} from "../testing/turns.ts";
import { Readiness } from "./Readiness.ts";

/** The engine project the server has for the bot, if any. */
const projectOf = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly engine_project_id: string | null }>`
      SELECT engine_project_id FROM bots WHERE id = ${botId}
    `;
    return row?.engine_project_id ?? null;
  });

/** What the database holds of the session the engine knew as `session`. */
const lostAt = (session: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly lost_at: string | null }>`
      SELECT lost_at FROM sessions WHERE engine_session_id = ${session}
    `;
    return row?.lost_at ?? null;
  });

/** The engine goes down and comes back, and the server has taken it in again. */
const restarted = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const readiness = yield* Readiness;
  const before = yield* readiness.generation;
  yield* control.setReachable(false);
  yield* control.setReachable(true);
  yield* until(readiness.generation.pipe(Effect.map((now) => now > before)));
});

it.effect(
  "loses every session of the engine before, once, when one on a fresh data directory is ready",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const ana = yield* createBot("Ana");
      const ben = yield* createBot("Ben");
      const anaSession = yield* engineSession(ana.id);
      const benSession = yield* engineSession(ben.id);
      const anaProject = yield* projectOf(ana.id);

      // Its streams of the sessions before get nothing more: only knowing
      // which engine answers tells the server they are gone.
      yield* control.startFresh;

      const anaNext = yield* sessionAfter(ana.id, anaSession);
      yield* sessionAfter(ben.id, benSession);
      assert.isNotNull(yield* lostAt(anaSession));
      assert.isNotNull(yield* lostAt(benSession));
      const newProject = yield* projectOf(ana.id);
      assert.isNotNull(newProject);
      assert.notStrictEqual(newProject, anaProject);

      const message = yield* sendToBot(ana.id, "Where were we?");
      yield* nextTurn(ana.id);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual((yield* control.dispatches(anaNext)).length, 1);
      for (const bot of [ana, ben]) {
        const lost = (yield* noticesOf(bot.id)).filter((tag) => tag === "session-lost");
        assert.deepStrictEqual(lost, ["session-lost"]);
      }

      // The same engine again, after a restart, loses nothing more.
      yield* restarted;
      assert.isNull(yield* lostAt(anaNext));
      assert.deepStrictEqual(
        (yield* noticesOf(ana.id)).filter((tag) => tag === "session-lost"),
        ["session-lost"],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps the sessions when no engine was recorded yet, as for a database from before the record",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const ana = yield* createBot("Ana");
      const session = yield* engineSession(ana.id);
      yield* sql`DELETE FROM engine_instance`;

      yield* restarted;
      const message = yield* sendToBot(ana.id, "Still there?");
      yield* until(control.dispatches(session).pipe(Effect.map((sent) => sent.length === 2)));
      yield* deliveryIs(message, "delivered");
      assert.isNull(yield* lostAt(session));
      assert.notInclude(yield* noticesOf(ana.id), "session-lost");
      const [recorded] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM engine_instance WHERE instance_id IS NOT NULL
      `;
      assert.strictEqual(recorded?.n, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("loses every session when the database says their engine is not this home's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ana = yield* createBot("Ana");
    const session = yield* engineSession(ana.id);
    // As `j3-bots import` leaves it.
    yield* sql`UPDATE engine_instance SET instance_id = NULL`;

    yield* restarted;
    yield* sessionAfter(ana.id, session);
    assert.isNotNull(yield* lostAt(session));
    assert.deepStrictEqual(
      (yield* noticesOf(ana.id)).filter((tag) => tag === "session-lost"),
      ["session-lost"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "loses a session still to open on the engine before, which opens again under a new key",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ana = yield* createBot("Ana");
      const session = yield* engineSession(ana.id);
      // The engine before may have opened it under its key without the server
      // hearing back: as a second import of one export leaves it.
      const [row] = yield* sql<{ readonly id: string }>`
        SELECT id FROM sessions WHERE engine_session_id = ${session}
      `;
      yield* sql`UPDATE sessions SET engine_session_id = NULL WHERE engine_session_id = ${session}`;
      yield* sql`UPDATE engine_instance SET instance_id = NULL`;

      yield* restarted;
      // A session the engine knows under another key: the row's own key is never sent again.
      yield* sessionAfter(ana.id, session);
      const [lost] = yield* sql<{ readonly lost_at: string | null }>`
        SELECT lost_at FROM sessions WHERE id = ${row?.id ?? ""}
      `;
      assert.isNotNull(lost?.lost_at ?? null);
    }).pipe(Effect.provide(TestDomain.layer)),
);
