// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  concurrentTurns,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  gateSettled,
  nextTurn,
  recoverTimes,
  roomOf,
  sendInRoom,
  sendToBot,
  sendWithFile,
  stopSettled,
  timesSent,
  turnEnded,
} from "../testing/turns.ts";
import { BotStates } from "./BotStates.ts";
import { MAX_INDETERMINATE_ANSWERS, recoveryBackoff } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Stops } from "./Stops.ts";

it.effect("never sends a message a Stop fenced while its send was staging in the gate", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(bot.id, "Publish the notes.");
    yield* staging.entered;
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* staging.release;

    yield* deliveryIs(message, "cancelled");
    yield* gateSettled(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Publish the notes."), 0);

    // The Stop had nothing running to end: the bot takes work again at once.
    const after = yield* sendToBot(bot.id, "Draft the changelog.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends as a start a steer whose turn ended while its file was staging", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Review the PR.");
    const turnId = yield* nextTurn(bot.id);

    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(bot.id, "Also read the notes.");
    yield* staging.entered;
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);
    yield* staging.release;

    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    const sent = (yield* control.dispatches(session)).filter((dispatch) =>
      dispatch.text.includes("Also read the notes."),
    );
    assert.deepStrictEqual(
      sent.map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stages a file again after its staging reply was lost, once the backoff passes", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(bot.id, "Read the notes.");
    yield* staging.entered;
    yield* control.loseNextReply;
    yield* staging.release;
    yield* gateSettled(bot.id);
    assert.strictEqual(yield* timesSent(session, "Read the notes."), 0);

    yield* recoverTimes(1);
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stages an expired file again before recovering the dispatch that carries it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // The send dies after its claim, applying nothing: the dispatch stays
    // undecided, and only the recovery can send it.
    yield* control.breakDispatches(true);
    const sending = yield* control.holdNext("dispatch");
    const message = yield* sendWithFile(bot.id, "Summarize the notes.");
    // The file's id as the engine staged it, as it stands.
    const stagedId = Effect.map(
      sql<{ readonly engine_attachment_id: string | null }>`
        SELECT a.engine_attachment_id FROM dispatch_attachments a
        JOIN wakes w ON w.dispatch_id = a.dispatch_id
        WHERE w.source_entry_id = ${message}
      `,
      ([row]) => row?.engine_attachment_id ?? null,
    );
    yield* sending.entered;
    yield* sending.release;
    yield* gateSettled(bot.id);
    yield* control.breakDispatches(false);
    const first = yield* stagedId;
    assert.isNotNull(first);

    // The recovery comes only after the staged file expired. The engine
    // refuses an expired id, so the file must be staged again for the resend
    // to be taken.
    yield* control.setReachable(false);
    yield* TestClock.adjust(Duration.hours(13));
    yield* control.setReachable(true);
    yield* (yield* Pipeline).recoverDue;

    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    const sent = (yield* control.dispatches(session)).filter((dispatch) =>
      dispatch.text.includes("Summarize the notes."),
    );
    const fresh = yield* stagedId;
    assert.notStrictEqual(fresh, first);
    assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<string | null>>>(
      sent.map((dispatch) => dispatch.attachments.map((file) => file.stagedId)),
      [[fresh]],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "fails a message whose recovery reached its bound, and delivers it if it lands late",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);

      const deferred = yield* control.deferNextDispatch;
      const message = yield* sendToBot(bot.id, "Tag the release.");
      yield* flushed(bot.id);
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(message, "failed");

      yield* deferred.land;
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* timesSent(session, "Tag the release."), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops a room's message that lands after its recovery gave up and the room stopped", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    const deferred = yield* control.deferNextDispatch;
    const message = yield* sendInRoom(bot.id, room.id, "Tag the release.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(message, "failed");

    // Archiving the room stops its work. The key may still land, so the Stop
    // covers it, also once settled.
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });
    yield* stopSettled;
    yield* deferred.land;
    yield* nextTurn(bot.id);
    yield* turnEnded(bot.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a send that keeps hitting an adapter defect, and lets a Stop settle", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    yield* control.breakDispatches(true);
    const message = yield* sendToBot(bot.id, "Rotate the keys.");
    yield* flushed(bot.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });

    // Each defect is an undecided answer: the bound ends it, well inside a day.
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(message, "cancelled");

    yield* control.breakDispatches(false);
    const after = yield* sendToBot(bot.id, "Then rotate the certificates.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.strictEqual(yield* timesSent(session, "Rotate the keys."), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "cancels a stopped message whose send stays undecided, and stops it when it lands late",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);

      const deferred = yield* control.deferNextDispatch;
      const message = yield* sendToBot(bot.id, "Rotate the keys.");
      yield* flushed(bot.id);
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });

      // The recovery owns the fenced dispatch, with its backoff; the Stop
      // waits on it, and the message is cancelled, never queued again.
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(message, "cancelled");

      // The key lands after all: the Stop it was fenced by ends its turn.
      yield* deferred.land;
      yield* turnEnded(bot.id);
      yield* deliveryIs(message, "cancelled");
      const after = yield* sendToBot(bot.id, "Then rotate the certificates.");
      yield* nextTurn(bot.id);
      yield* deliveryIs(after, "delivered");
      assert.strictEqual(yield* timesSent(session, "Rotate the keys."), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a dispatch left unsent by a restart, with no wake pending for its bot", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      // The dispatch is written, and its send finds the engine gone.
      const sending = yield* control.holdNext("dispatch");
      const message = yield* sendToBot(bot.id, "Archive the logs.");
      yield* sending.entered;
      yield* control.setReachable(false);
      yield* sending.release;
      yield* gateSettled(bot.id);
      return { bot, session, message };
    });
    const { bot, session, message } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    yield* control.setReachable(true);
    yield* Effect.gen(function* () {
      yield* nextTurn(bot.id);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* timesSent(session, "Archive the logs."), 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("shows a lost session once and plans nothing into it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* control.loseSession(session);

    // The first send finds out.
    const message = yield* sendToBot(bot.id, "Are you there?");
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "session-lost" });
    yield* flushed(bot.id);
    yield* TestClock.adjust(Duration.minutes(5));
    yield* flushed(bot.id);

    assert.strictEqual(yield* timesSent(session, "Are you there?"), 0);
    const notices = (yield* conversation(bot.id)).filter((entry) => entry._tag === "notice");
    assert.strictEqual(notices.length, 1);
    yield* deliveryIs(message, "pending");
    assert.deepStrictEqual(yield* (yield* BotStates).of(bot.id), { _tag: "idle" });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("settles a lost session's undecided send without holding up another bot", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    yield* engineSession(bia.id);

    // Ana's send stays undecided, and then the engine loses her session.
    yield* control.deferNextDispatch;
    const undecided = yield* sendToBot(ana.id, "Back up the database.");
    yield* flushed(ana.id);
    yield* control.loseSession(anaSession);
    yield* deliveryIs(undecided, "failed");

    const message = yield* sendToBot(bia.id, "Check the dashboards.");
    yield* nextTurn(bia.id);
    yield* deliveryIs(message, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("goes on with another bot's recovery when settling one dispatch hits a defect", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    yield* engineSession(bia.id);

    // Both sends stay undecided: Ana's first, so the recovery reaches it first.
    yield* control.deferNextDispatch;
    yield* sendToBot(ana.id, "Back up the database.");
    yield* flushed(ana.id);
    yield* control.deferNextDispatch;
    yield* sendToBot(bia.id, "Check the dashboards.");
    yield* flushed(bia.id);

    // Settling Ana's dispatch, and counting it against its bounds, are bugs
    // here; only its deadline can still move. A trigger takes no bound
    // values; the id is one the server generated.
    yield* sql.unsafe(`
      CREATE TRIGGER poison BEFORE UPDATE ON dispatches
      WHEN NEW.bot_id = '${ana.id}' AND (
        NEW.status IS NOT OLD.status
        OR NEW.indeterminate_answers IS NOT OLD.indeterminate_answers
        OR NEW.staging_failures IS NOT OLD.staging_failures
      )
      BEGIN SELECT RAISE(ABORT, 'poison'); END
    `);
    // Her session is lost, so its undecided send is due at once and settles.
    yield* control.loseSession(anaSession);
    yield* awaitEntry(ana.id, "notice");

    // Bia's resend still goes out once its backoff passes.
    const resend = yield* control.holdNext("redispatch");
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* resend.entered;
    yield* resend.release;
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves a first send whose attempt was given back to the dispatcher and its budget", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* concurrentTurns(3);
    const cid = yield* createBot("Cid");
    yield* engineSession(cid.id);
    const dan = yield* createBot("Dan");
    yield* engineSession(dan.id);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);
    yield* flushed(bia.id);

    // Cid's and Dan's sends stay undecided and hold two slots; Dan's resend
    // falls due a second after Cid's.
    yield* control.deferNextDispatch;
    yield* sendToBot(cid.id, "Rotate the logs.");
    yield* flushed(cid.id);
    yield* TestClock.adjust("1 second");
    yield* control.deferNextDispatch;
    yield* sendToBot(dan.id, "Prune the images.");
    yield* flushed(dan.id);

    // A recovery pass resends Cid's, and waits at the engine's door: no
    // other pass runs meanwhile. Ana's first send takes the last slot and
    // waits there too, while Bia's own turn starts.
    const cidResend = yield* control.holdNext("redispatch");
    yield* TestClock.adjust("1 second");
    yield* cidResend.entered;
    const sending = yield* control.holdNext("dispatch");
    const message = yield* sendToBot(ana.id, "Merge the branch.");
    yield* sending.entered;
    const biaTurn = yield* control.startEngineTurn(biaSession);
    yield* nextTurn(bia.id);

    // The next pass picks up every claimed send, Ana's included, and waits
    // on Dan's resend.
    const danResend = yield* control.holdNext("redispatch");
    yield* TestClock.adjust("1 second");
    yield* cidResend.release;
    yield* danResend.entered;

    // The engine cannot be reached: Ana's attempt is given back, and with
    // Cid's, Dan's and Bia's work no slot is free for it.
    yield* control.setReachable(false);
    yield* sending.release;
    yield* gateSettled(ana.id);
    yield* control.setReachable(true);

    // The pass goes on to Ana's dispatch, which is no longer the recovery's.
    yield* danResend.release;
    yield* (yield* Pipeline).recoverDue;
    yield* flushed(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Merge the branch."), 0);

    // The dispatcher sends it once a slot frees.
    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bia.id);
    yield* flushed(ana.id);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Merge the branch."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);
