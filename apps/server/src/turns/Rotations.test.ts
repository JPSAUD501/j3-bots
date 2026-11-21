// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { BotTools } from "../tools/BotTools.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  createNewBot,
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
  stopSettled,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { MAX_INDETERMINATE_ANSWERS, type SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Pipeline } from "./Pipeline.ts";
import { RETRY_TICK } from "./reconciler.ts";
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

/**
 * Brings the bot's main session to exactly `ROTATE_AFTER_RUNS` turns, its own
 * (the opening included) and turns long finished, as weeks of work would add.
 */
const reachRunLimit = (sessionId: SessionRowId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(yield* DateTime.now);
    const [ran] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM turns WHERE session_id = ${sessionId}
    `;
    // One transaction: a commit per row would take seconds.
    yield* sql.withTransaction(
      Effect.forEach(
        Array.from({ length: ROTATE_AFTER_RUNS - (ran?.n ?? 0) }, (_, n) => n),
        (n) => sql`
          INSERT INTO turns (
            session_id, engine_turn_id, audience, started_at, last_activity_at, finished_at,
            outcome_json
          ) VALUES (
            ${sessionId}, ${`old-${n}`}, 'conversation', ${at}, ${at}, ${at}, '{"_tag":"completed"}'
          )
        `,
        { discard: true },
      ),
    );
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

it.effect(
  "applies a permission mode lowered while the engine was unavailable before the bot's next turn",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      const session = yield* engineSession(bot.id);
      const main = yield* mainSessionId(bot.id);

      // Saved while the engine cannot take it, and a message follows.
      yield* control.setReachable(false);
      const lowered = yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });
      assert.strictEqual(lowered.permissionMode, "supervised");
      yield* sendToBot(bot.id, "Deploy the release.");

      // The engine is back and the session still runs in full access: the
      // message waits, with the session's events known.
      const aligning = yield* control.holdNext("configureSession");
      yield* control.setReachable(true);
      yield* aligning.entered;
      const observer = yield* Observer;
      yield* until(observer.watch(main).pipe(Effect.andThen(observer.ready(main))));
      yield* (yield* Pipeline).dispatchPending;
      assert.strictEqual(yield* control.sessionPermissionMode(session), "full-access");
      assert.strictEqual(yield* timesSent(session, "Deploy the release."), 0);

      yield* aligning.release;
      yield* nextTurn(bot.id);
      assert.strictEqual(yield* control.sessionPermissionMode(session), "supervised");
      assert.strictEqual(yield* timesSent(session, "Deploy the release."), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("aligns a session again after its alignment failed, before it takes work", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bots = yield* Bots;
    yield* TestClock.adjust("1 second");
    const bot = yield* bots.create({
      commandId: command(),
      draft: { name: "Ana", job: "", permissionMode: "full-access" },
    });
    const session = yield* engineSession(bot.id);

    // The engine applies the change, and its reply is lost: the server cannot
    // tell, and the session takes no work.
    const aligning = yield* control.holdNext("configureSession");
    yield* bots.update({
      commandId: command(),
      botId: bot.id,
      changes: { permissionMode: "supervised" },
    });
    yield* aligning.entered;
    yield* sendToBot(bot.id, "Deploy the release.");
    yield* control.loseNextReply;
    yield* aligning.release;
    yield* (yield* Rotations).rotateDue;
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Deploy the release."), 0);

    // Tried again after its backoff.
    yield* TestClock.adjust("5 seconds");
    yield* nextTurn(bot.id);
    assert.strictEqual(yield* control.sessionPermissionMode(session), "supervised");
    assert.strictEqual(yield* timesSent(session, "Deploy the release."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "applies a permission mode changed during a turn once that turn has ended, leaving the turn whole",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Deploy the release.");
      const running = yield* nextTurn(bot.id);

      // Changing it now could end the turn: it keeps the mode it started with.
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });
      yield* (yield* Rotations).rotateDue;
      assert.strictEqual(yield* control.sessionPermissionMode(session), "full-access");

      // Its end nudges the rotator, with no backoff to wait out.
      yield* finish(bot.id, session, running);
      yield* until(
        control.sessionPermissionMode(session).pipe(Effect.map((mode) => mode === "supervised")),
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds a permission mode while background work runs, telling the conversation once, and applies it after",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      const rotations = yield* Rotations;
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Start the dev server.");
      const started = yield* nextTurn(bot.id);
      yield* control.startBackgroundWork({ sessionId: session, turnId: started });
      yield* finish(bot.id, session, started);

      // The engine refuses the change while the work runs, which it would end.
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });
      yield* rotations.rotateDue;
      const message = yield* sendToBot(bot.id, "Is it up?");
      yield* TestClock.adjust("30 seconds");
      yield* rotations.rotateDue;
      yield* flushed(bot.id);
      assert.strictEqual(yield* control.sessionPermissionMode(session), "full-access");
      assert.strictEqual(yield* timesSent(session, "Is it up?"), 0);
      const told = (yield* noticesOf(bot.id)).filter((tag) => tag === "settings-held");
      assert.lengthOf(told, 1);

      // The work ends with no event: the next look applies the change.
      yield* control.endBackgroundWork(session);
      yield* TestClock.adjust("30 seconds");
      yield* nextTurn(bot.id, started);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* control.sessionPermissionMode(session), "supervised");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers a Stop while background work holds a settings change, and the Stop applies it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      const store = yield* BotStore;
      const rotations = yield* Rotations;
      const stored = (botId: BotId) =>
        store.find(botId).pipe(Effect.map((found) => Option.getOrThrow(found).bot));
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Start the dev server.");
      const started = yield* nextTurn(bot.id);
      yield* control.startBackgroundWork({ sessionId: session, turnId: started });
      yield* finish(bot.id, session, started);
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });
      yield* rotations.rotateDue;
      // Idle, with no turn to stop: the roster says the change waits.
      const waiting = yield* stored(bot.id);
      assert.strictEqual(waiting.state._tag, "idle");
      assert.isTrue(waiting.settingsHeld);

      // The Stop ends the work, and its settling applies the change.
      const stops = yield* Stops;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* stops.runPending;
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
      yield* until(
        control.sessionPermissionMode(session).pipe(Effect.map((mode) => mode === "supervised")),
      );
      yield* until(stored(bot.id).pipe(Effect.map((after) => !after.settingsHeld)));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("tells clients a held settings change is gone once its session is retired", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bots = yield* Bots;
    const store = yield* BotStore;
    const rotations = yield* Rotations;
    const sql = yield* SqlClient.SqlClient;
    const settingsHeld = (botId: BotId) =>
      store.find(botId).pipe(Effect.map((found) => Option.getOrThrow(found).bot.settingsHeld));
    yield* TestClock.adjust("1 second");
    const bot = yield* bots.create({
      commandId: command(),
      draft: { name: "Ana", job: "", permissionMode: "full-access" },
    });
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Start the dev server.");
    const started = yield* nextTurn(bot.id);
    yield* control.startBackgroundWork({ sessionId: session, turnId: started });
    yield* finish(bot.id, session, started);
    yield* bots.update({
      commandId: command(),
      botId: bot.id,
      changes: { permissionMode: "supervised" },
    });
    yield* rotations.rotateDue;
    assert.isTrue(yield* settingsHeld(bot.id));

    // Archived from the engine's console, the next alignment finds it gone,
    // and the session is retired. No replacement opens, so nothing but the
    // retirement tells clients.
    const changes = yield* (yield* ChangeLog).subscribe;
    yield* control.failNextOpenSessions(1);
    yield* control.archiveSession(session);
    yield* rotations.rotateDue;
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM sessions
        WHERE engine_session_id = ${session} AND retired_at IS NOT NULL
      `.pipe(Effect.map(([row]) => row?.n === 1)),
    );
    const told = yield* PubSub.takeUpTo(changes, Number.POSITIVE_INFINITY);
    assert.isFalse(yield* settingsHeld(bot.id));
    assert.isTrue(told.some((scope) => scope._tag === "bot" && scope.botId === bot.id));
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "replaces a session archived from the engine's console while a settings change waited for it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      yield* TestClock.adjust("1 second");
      const bot = yield* bots.create({
        commandId: command(),
        draft: { name: "Ana", job: "", permissionMode: "full-access" },
      });
      const session = yield* engineSession(bot.id);
      yield* exchange(bot.id, session, "Plan the launch.", "Drafted it.");
      const archived = yield* mainSessionId(bot.id);
      const observer = yield* Observer;
      assert.isTrue(yield* observer.ready(archived));
      // Its event stream stays open: only the alignment finds it gone.
      yield* control.archiveSession(session);
      yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { permissionMode: "supervised" },
      });

      const replacement = yield* sessionAfter(bot.id, session);
      assert.strictEqual(yield* control.sessionPermissionMode(replacement), "supervised");
      const message = yield* sendToBot(bot.id, "Still there?");
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      // The replaced session's events are no longer followed.
      assert.isFalse(yield* observer.ready(archived));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("never opens a session on the provider its bot moved away from", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    // The bot's first session is written on its provider and cannot be
    // opened yet; the bot then moves to another provider.
    yield* control.failNextOpenSessions(2);
    const bot = yield* createNewBot("Ana");
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

it.effect(
  "applies no event of a replaced session once the engine's archive of it is recorded",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const observer = yield* Observer;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const old = yield* mainSessionId(bot.id);
      yield* reachRunLimit(old);

      // The session is retired and still followed, its replacement opening,
      // when the archive's settling commits and the engine starts a turn there
      // that the stream still delivers.
      const opening = yield* control.holdNext("configureSession");
      const pass = yield* (yield* Rotations).rotateDue.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* opening.entered;
      yield* sql`
      UPDATE sessions SET engine_retired_at = ${DateTime.formatIso(yield* DateTime.now)}
      WHERE id = ${old}
    `;
      yield* control.startEngineTurn(session);
      const openTurns = sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM turns WHERE session_id = ${old} AND finished_at IS NULL
    `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.n ?? 0),
      );
      // Applied, or the stream let go of without applying it.
      yield* until(
        Effect.zipWith(openTurns, observer.ready(old), (open, ready) => open > 0 || !ready),
      );
      assert.strictEqual(yield* openTurns, 0);
      yield* opening.release;
      yield* Fiber.join(pass);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("reports each turn with its bot and provider, newest first", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    // Bia's first turn runs before the period, on the provider it then leaves.
    const bia = yield* createBot("Bia");
    const biaFirst = yield* engineSession(bia.id);
    yield* TestClock.adjust("1 second");
    const since = yield* DateTime.now;
    yield* TestClock.adjust("1 second");
    yield* exchange(ana.id, anaSession, "First.", "One.");
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bia.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });
    const biaSession = yield* sessionAfter(bia.id, biaFirst);
    yield* TestClock.adjust("1 second");
    yield* exchange(bia.id, biaSession, "Second.", "Two.");

    // The period reaches back to `since` from the moment the server reads, and that moment is told.
    const now = yield* DateTime.now;
    const period = DateTime.distance(since, now);
    const usage = yield* Usage;
    const page = yield* usage.turns({ period, limit: 1 });
    assert.isTrue(page.hasMore);
    const all = yield* usage.turns({ period, limit: 10 });
    assert.isFalse(all.hasMore);
    assert.isTrue(DateTime.Equivalence(all.readAt, now));
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
