// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Attachments } from "../attachments/Attachments.ts";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  gateSettled,
  nextTurn,
  sendToBot,
  timesSent,
  turnEnded,
} from "../testing/turns.ts";
import { BotStates } from "./BotStates.ts";
import { MAX_INDETERMINATE_ANSWERS, recoveryBackoff } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Stops } from "./Stops.ts";

/** The operator writes to the bot with a file attached. */
const sendWithFile = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const file = yield* (yield* Attachments).store({
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Release notes."),
    });
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId },
      text,
      attachments: [file.id],
    });
  });

/** Runs the recovery once each backoff passes, `times` times. */
const recoverTimes = (times: number) =>
  Effect.gen(function* () {
    const pipeline = yield* Pipeline;
    for (let answer = 1; answer <= times; answer++) {
      yield* TestClock.adjust(recoveryBackoff(answer));
      yield* pipeline.recoverDue;
    }
  });

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

    // The engine queues the start behind a turn of its own, and the answer is
    // lost: the dispatch stays undecided while that turn runs.
    yield* control.startEngineTurnDuringNextDispatch(session);
    const sending = yield* control.holdNext("dispatch");
    const message = yield* sendWithFile(bot.id, "Summarize the notes.");
    yield* sending.entered;
    yield* control.loseNextReply;
    yield* sending.release;
    const ownTurn = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // The recovery comes only after the staged file expired. The engine
    // refuses an expired id, so the file must be staged again for the resend
    // to be taken.
    yield* control.setReachable(false);
    yield* TestClock.adjust(Duration.hours(13));
    yield* control.setReachable(true);
    yield* (yield* Pipeline).recoverDue;
    const [row] = yield* sql<{ readonly status: string }>`
      SELECT d.status FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
      WHERE w.source_entry_id = ${message}
    `;
    assert.strictEqual(row?.status, "accepted");

    yield* control.finishTurn({
      sessionId: session,
      turnId: ownTurn,
      outcome: { _tag: "completed" },
    });
    const delivered = yield* nextTurn(bot.id, ownTurn);
    yield* deliveryIs(message, "delivered");
    yield* control.finishTurn({
      sessionId: session,
      turnId: delivered,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    assert.strictEqual(yield* timesSent(session, "Summarize the notes."), 1);
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
