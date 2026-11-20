// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { BotTools } from "../tools/BotTools.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  deliveryIs,
  engineSession,
  failedAs,
  flushed,
  mainSessionId,
  nextTurn,
  noticesOf,
  recoverTimes,
  sendToBot,
  sendWithFile,
  sessionAfter,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { MAX_INDETERMINATE_ANSWERS, type SessionRowId } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Rotations, ROTATE_AFTER_RUNS } from "./Rotations.ts";
import { Stops } from "./Stops.ts";
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

/** The bot says it is done and its turn completes, so no `undelivered` follow-up runs. */
const finish = (botId: BotId, session: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const args = { text: "Done.", done: true };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: `say-${turnId}`,
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
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
    assert.strictEqual(rows.length, 1);
    return typeof rows[0]?.engine_retired_at === "string";
  });

/** Gives the bot's main session `ROTATE_AFTER_RUNS` turns long finished, as weeks of work would. */
const reachRunLimit = (sessionId: SessionRowId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(yield* DateTime.now);
    for (let n = 0; n < ROTATE_AFTER_RUNS; n++) {
      yield* sql`
        INSERT INTO turns (
          session_id, engine_turn_id, audience, started_at, last_activity_at, finished_at,
          outcome_json
        ) VALUES (
          ${sessionId}, ${`old-${n}`}, 'conversation', ${at}, ${at}, ${at}, '{"_tag":"completed"}'
        )
      `;
    }
  });

/**
 * Waits until the bot's lost main session is retired and the opening of its
 * replacement failed: the row is written, and the rotator's pass that tried
 * it is over.
 */
const replacementUnopened = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
          AND engine_session_id IS NULL
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.n === 1),
      ),
    );
    yield* (yield* Rotations).rotateDue;
  });

/** The text of the first envelope a session received. */
const firstEnvelope = (session: SessionId) =>
  Effect.gen(function* () {
    const [first] = yield* (yield* TestEngineControl).dispatches(session);
    return first?.text ?? "";
  });

it.effect(
  "starts a bot fresh: its work in progress stops, and the new session gets no digest",
  () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it in files/launch.md.");
      yield* sendToBot(bot.id, "Back up the database.");
      yield* nextTurn(bot.id);

      yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
      // Written after the fresh start: it waits for the new session.
      const waiting = yield* sendToBot(bot.id, "Then the logs.");
      yield* turnEnded(bot.id);
      const replacement = yield* sessionAfter(bot.id, session);
      assert.isTrue(yield* retiredInEngine(session));

      yield* nextTurn(bot.id);
      yield* deliveryIs(waiting, "delivered");
      assert.strictEqual(yield* timesSent(session, "Then the logs."), 0);
      const text = yield* firstEnvelope(replacement);
      assert.include(text, "Then the logs.");
      assert.notInclude(text, "Your working session was replaced.");
      assert.notInclude(text, "Plan the launch.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "starts a bot fresh with no live main session, dropping a digest no envelope carried yet",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");

      // The engine loses the session, and the one replacing it cannot be
      // opened yet: the bot has a digest waiting and no opened session.
      yield* control.failNextOpenSessions(1);
      yield* control.loseSession(session);
      yield* replacementUnopened(bot.id);
      yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });

      yield* TestClock.adjust("1 minute");
      const replacement = yield* sessionAfter(bot.id, session);
      const message = yield* sendToBot(bot.id, "Start over.");
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      const text = yield* firstEnvelope(replacement);
      assert.notInclude(text, "Your working session was replaced.");
      assert.notInclude(text, "Plan the launch.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("replaces a lost session with one whose first envelope carries the digest", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* exchange(bot.id, session, "Plan the launch.", "Drafted it in files/launch.md.");
    yield* control.loseSession(session);
    const replacement = yield* sessionAfter(bot.id, session);

    const message = yield* sendToBot(bot.id, "And the budget?");
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    const text = yield* firstEnvelope(replacement);
    assert.include(text, "Your working session was replaced.");
    assert.include(text, "Plan the launch.");
    assert.match(text, /from="you">\nDrafted it in files\/launch\.md\./);
    // The message itself arrives once, as the message, not in the digest too.
    assert.strictEqual(text.split("And the budget?").length - 1, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the digest for the next envelope when the engine rejects the first one", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* exchange(bot.id, session, "Plan the launch.", "Drafted it in files/launch.md.");
    yield* control.loseSession(session);
    const replacement = yield* sessionAfter(bot.id, session);

    yield* control.rejectNextDispatch;
    const message = yield* sendToBot(bot.id, "And the budget?");
    yield* failedAs(message, "rejected");
    yield* (yield* Pipeline).retryMessage({ commandId: command(), entryId: message });
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    const sent = yield* control.dispatches(replacement);
    const text = sent.at(-1)?.text ?? "";
    assert.include(text, "And the budget?");
    assert.include(text, "Your working session was replaced.");
    assert.include(text, "Plan the launch.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps a fresh start when the fresh session is lost: its replacement is told nothing from before",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it in files/launch.md.");
      yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
      const fresh = yield* sessionAfter(bot.id, session);

      // The engine loses the fresh session before it ran anything; the next
      // message finds it gone, and the session replacing it gets a digest.
      yield* control.loseSession(fresh);
      const message = yield* sendToBot(bot.id, "Where were we?");
      const replacement = yield* sessionAfter(bot.id, fresh);
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      const text = yield* firstEnvelope(replacement);
      assert.include(text, "Your working session was replaced.");
      assert.notInclude(text, "Plan the launch.");
      assert.notInclude(text, "Drafted it");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "drops the digest an unsent dispatch carried into a lost session: the next one carries one",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");
      yield* control.loseSession(session);
      const replacement = yield* sessionAfter(bot.id, session);

      // A dispatch carrying the digest is written into the replacement, and
      // its file stages while that session is lost and replaced in its turn.
      const staging = yield* control.holdNext("stageAttachment");
      const message = yield* sendWithFile(bot.id, "Read the notes.");
      yield* staging.entered;
      yield* control.loseSession(replacement);
      const next = yield* sessionAfter(bot.id, replacement);
      yield* staging.release;

      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      const text = yield* firstEnvelope(next);
      assert.strictEqual(text.split("Your working session was replaced.").length - 1, 1);
      assert.strictEqual(text.split("Plan the launch.").length - 1, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "waits for background work a turn handed off before a run-limit rotation, planning into the session meanwhile",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const rotations = yield* Rotations;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Start the dev server.");
      const started = yield* nextTurn(bot.id);
      // The turn hands off to background work that wakes the bot when it ends.
      yield* control.startBackgroundWork({ sessionId: session, turnId: started });
      yield* finish(bot.id, session, started);
      yield* reachRunLimit(yield* mainSessionId(bot.id));

      yield* rotations.rotateDue;
      assert.strictEqual(yield* engineSession(bot.id), session);
      // The server is still running: the bot's wakes are not held for it.
      const meanwhile = yield* sendToBot(bot.id, "Is it up?");
      const answering = yield* nextTurn(bot.id, started);
      yield* deliveryIs(meanwhile, "delivered");
      assert.strictEqual(yield* timesSent(session, "Is it up?"), 1);
      yield* finish(bot.id, session, answering);
      yield* rotations.rotateDue;
      assert.strictEqual(yield* engineSession(bot.id), session);

      yield* control.endBackgroundWork(session);
      yield* rotations.rotateDue;
      yield* sessionAfter(bot.id, session);
      assert.isTrue(yield* retiredInEngine(session));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds a rotation for a run the engine took from a send the recovery gave up on", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const landing = yield* control.deferNextDispatch;
    const message = yield* sendToBot(bot.id, "Rotate the keys.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* failedAs(message, "unresolved");

    // It lands after all, and its turn waits to start: no event tells of it.
    const startup = yield* control.holdNextStartup(session);
    yield* landing.land;
    yield* reachRunLimit(yield* mainSessionId(bot.id));
    yield* (yield* Rotations).rotateDue;
    assert.strictEqual(yield* engineSession(bot.id), session);

    yield* startup.release;
    const turnId = yield* nextTurn(bot.id);
    yield* finish(bot.id, session, turnId);
    yield* sessionAfter(bot.id, session);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("opens a bot's main session again after a failed opening, with no engine restart", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");
    yield* control.failNextOpenSessions(1);
    yield* control.loseSession(session);
    yield* replacementUnopened(bot.id);

    yield* TestClock.adjust("10 seconds");
    yield* (yield* Rotations).rotateDue;
    yield* sessionAfter(bot.id, session);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "opens a bot's session with the permission mode it has now, after the reply to an opening was lost",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      // The engine opens the session in full access, and its answer is lost.
      yield* control.loseNextOpenSessionReply;
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });

      // Opened again under its key, the engine answers with that session.
      yield* TestClock.adjust("1 minute");
      yield* (yield* Rotations).rotateDue;
      const session = yield* engineSession(bot.id);
      assert.strictEqual(yield* control.sessionPermissionMode(session), "supervised");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("never opens a session on the provider its bot moved away from", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    // The bot's first session is written on its provider and cannot be
    // opened yet; the bot then moves to another provider.
    yield* control.failNextOpenSessions(2);
    const bot = yield* createBot("Ana");
    yield* (yield* Rotations).rotateDue;
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });

    yield* TestClock.adjust("1 minute");
    yield* (yield* Rotations).rotateDue;
    const session = yield* engineSession(bot.id);
    const model = yield* control.sessionModel(session);
    assert.strictEqual(model.providerId, TestDomain.OTHER_PROVIDER_MODEL.providerId);
    const opened = yield* sql<{ readonly provider_id: string }>`
      SELECT provider_id FROM sessions WHERE bot_id = ${bot.id} AND engine_session_id IS NOT NULL
    `;
    assert.deepStrictEqual(
      opened.map((row) => row.provider_id),
      [TestDomain.OTHER_PROVIDER_MODEL.providerId],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps a session whose bot moves to another provider and back before it is replaced",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const main = yield* mainSessionId(bot.id);
      yield* sendToBot(bot.id, "Back up the database.");
      yield* nextTurn(bot.id);

      // The move's Stop is still ending the turn when the operator moves the bot back.
      const stopping = yield* control.delayNextStopEffects;
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
      });
      yield* bots.update({ commandId: command(), botId: bot.id, changes: { model: bot.model } });
      yield* stopping.release;
      yield* turnEnded(bot.id);
      yield* (yield* Rotations).rotateDue;

      assert.strictEqual(yield* mainSessionId(bot.id), main);
      const message = yield* sendToBot(bot.id, "Then the logs.");
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* timesSent(session, "Then the logs."), 1);
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

      // The move stops the work in progress first, and the new session gets
      // the digest.
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");
      yield* sendToBot(bot.id, "Back up the database.");
      yield* nextTurn(bot.id);
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
      });
      yield* turnEnded(bot.id);
      const replacement = yield* sessionAfter(bot.id, session);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly provider_id: string }>`
        SELECT provider_id FROM sessions WHERE id = ${yield* mainSessionId(bot.id)}
      `;
      assert.strictEqual(row?.provider_id, TestDomain.OTHER_PROVIDER_MODEL.providerId);
      yield* sendToBot(bot.id, "Where were we?");
      yield* nextTurn(bot.id);
      const text = yield* firstEnvelope(replacement);
      assert.include(text, "Your working session was replaced.");
      assert.include(text, "Plan the launch.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("replaces a session that reached its run limit", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* reachRunLimit(yield* mainSessionId(bot.id));
    yield* (yield* Rotations).rotateDue;
    yield* sessionAfter(bot.id, session);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a turn still open in a replaced session once the engine archives it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const old = yield* mainSessionId(bot.id);
    yield* reachRunLimit(old);

    // The session is retired, and its replacement opening, when the engine
    // starts a turn there, as finished background work can: nothing will
    // report its end once the server stops following the session.
    const opening = yield* control.holdNext("configureSession");
    const pass = yield* (yield* Rotations).rotateDue.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* opening.entered;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO turns (session_id, engine_turn_id, audience, started_at, last_activity_at)
      VALUES (${old}, 'late', 'conversation', ${at}, ${at})
    `;
    yield* opening.release;
    yield* Fiber.join(pass);

    assert.isTrue(yield* retiredInEngine(session));
    const [late] = yield* sql<{ readonly ending: string | null }>`
      SELECT json_extract(outcome_json, '$._tag') AS ending FROM turns
      WHERE session_id = ${old} AND engine_turn_id = 'late' AND finished_at IS NOT NULL
    `;
    assert.strictEqual(late?.ending, "interrupted");
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

it.effect("leaves a session the engine retired out of a later Stop, and tells of no loss", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");
    // A dispatch of it whose fate the server never learned: one that may still land.
    yield* sql`
      UPDATE dispatches SET status = 'failed', failure_reason = 'unresolved'
      WHERE session_id = (SELECT id FROM sessions WHERE engine_session_id = ${session})
    `;
    yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
    yield* sessionAfter(bot.id, session);
    assert.isTrue(yield* retiredInEngine(session));

    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    const [targets] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM stop_targets t JOIN sessions s ON s.id = t.session_id
      WHERE s.engine_session_id = ${session} AND t.stopped_at IS NULL
    `;
    assert.strictEqual(targets?.n, 0);
    assert.notInclude(yield* noticesOf(bot.id), "session-lost");
  }).pipe(Effect.provide(TestDomain.layer)),
);
