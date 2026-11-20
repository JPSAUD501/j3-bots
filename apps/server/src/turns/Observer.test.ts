// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, WorkStepId } from "@j3-bots/contracts";
import { Engine, EventCursor, IdempotencyKey } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  eventually,
  flushed,
  gateSettled,
  nextTurn,
  sendToBot,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { BotStates } from "./BotStates.ts";
import { HeldQueues } from "./HeldQueues.ts";
import { recoveryBackoff, STALL_AFTER } from "./model.ts";
import { Stops } from "./Stops.ts";
import { WorkSteps } from "./WorkSteps.ts";

/** A running turn, and a second message sent into it as a steer. */
const steering = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Review the PR.");
  const turnId = yield* nextTurn(bot.id);
  const steer = yield* sendToBot(bot.id, "Also check the tests.");
  yield* flushed(bot.id);
  const received = yield* control.dispatches(session);
  assert.deepStrictEqual(received[1]?.delivery, { _tag: "steer", turnId });
  return { control, bot, session, turnId, steer };
});

it.effect("delivers a steer the turn read, with no turn after it", () =>
  Effect.gen(function* () {
    const { control, bot, session, turnId, steer } = yield* steering;
    yield* control.readSteers({ sessionId: session, turnId });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });

    yield* deliveryIs(steer, "delivered");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Also check the tests."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("delivers a steer the turn ended without reading in the follow-up turn", () =>
  Effect.gen(function* () {
    const { control, bot, session, turnId, steer } = yield* steering;
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });

    const followUp = yield* nextTurn(bot.id, turnId);
    yield* deliveryIs(steer, "delivered");
    yield* control.finishTurn({
      sessionId: session,
      turnId: followUp,
      outcome: { _tag: "completed" },
    });
    yield* flushed(bot.id);
    // The engine ran it again on its own: nothing was sent twice.
    assert.strictEqual(yield* timesSent(session, "Also check the tests."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels a steer Stop dropped", () =>
  Effect.gen(function* () {
    const { bot, session, steer } = yield* steering;
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });

    yield* deliveryIs(steer, "cancelled");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Also check the tests."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("reconciles a replaced history by its ids, applying each ended turn once", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Plan the release.");
      const done = yield* nextTurn(bot.id);
      yield* control.finishTurn({
        sessionId: session,
        turnId: done,
        outcome: { _tag: "completed" },
      });
      // A user turn that said nothing is followed up once, by J3 Bots.
      const followUp = yield* nextTurn(bot.id, done);
      yield* control.finishTurn({
        sessionId: session,
        turnId: followUp,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
      yield* flushed(bot.id);

      const message = yield* sendToBot(bot.id, "Cut the branch.");
      const running = yield* nextTurn(bot.id, followUp);
      yield* deliveryIs(message, "delivered");
      return { bot, session, running };
    });
    const { bot, session, running } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    // While the server is down the turn works and fails, background work starts
    // a turn of its own, and the engine forgets the history the server's cursor names.
    const at = yield* DateTime.now;
    yield* control.step({
      sessionId: session,
      turnId: running,
      step: {
        id: WorkStepId.make("step-1"),
        kind: "command",
        label: "git switch -c release",
        status: "completed",
        startedAt: at,
        finishedAt: at,
      },
    });
    yield* control.finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    const ownTurn = yield* control.startEngineTurn(session);
    yield* control.pruneHistory(session);

    yield* Effect.gen(function* () {
      yield* until(
        (yield* BotStates).of(bot.id).pipe(Effect.map((state) => state._tag === "thinking")),
      );
      const failed = { _tag: "turn-failed", failure: "provider-error" } as const;
      const entries = yield* eventually(
        conversation(bot.id).pipe(
          Effect.map((all) =>
            all.some((entry) => entry._tag === "notice" && entry.notice._tag === failed._tag)
              ? Option.some(all)
              : Option.none(),
          ),
        ),
      );
      // The replacement listed every ended turn again: each was applied once.
      assert.deepStrictEqual(
        entries.flatMap((entry) => (entry._tag === "notice" ? [entry.notice] : [])),
        [{ _tag: "undelivered" }, failed],
      );
      const folds = entries.flatMap((entry) => (entry._tag === "work-fold" ? [entry] : []));
      assert.strictEqual(folds.length, 1);
      assert.strictEqual(folds[0]?.stepCount, 1);
      assert.strictEqual(folds[0]?.status._tag === "finished" && folds[0].status.ending, "failed");
      yield* control.finishTurn({
        sessionId: session,
        turnId: ownTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
      yield* gateSettled(bot.id);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("streams a fold's steps as they change, until its turn ends", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Run the tests.");
    const turnId = yield* nextTurn(bot.id);
    const startedAt = yield* DateTime.now;
    const running = {
      id: WorkStepId.make("step-1"),
      kind: "command",
      label: "pnpm test",
      status: "running",
      startedAt,
      finishedAt: null,
    } as const;
    yield* control.step({ sessionId: session, turnId, step: running });
    const fold = yield* awaitEntry(bot.id, "work-fold");

    const following = yield* (yield* WorkSteps)
      .follow(fold.id)
      .pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("30 seconds");
    const finishedAt = yield* DateTime.now;
    yield* control.step({
      sessionId: session,
      turnId,
      step: { ...running, status: "completed", finishedAt },
    });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });

    // The stream ends with the turn; the step's last state is its result.
    const frames = yield* Fiber.join(following);
    const last = frames
      .flatMap((frame) => (frame._tag === "snapshot" ? frame.steps : [frame.step]))
      .at(-1);
    assert.strictEqual(last?.status, "completed");
    assert.isTrue(
      last !== undefined &&
        last.finishedAt !== null &&
        DateTime.Equivalence(last.finishedAt, finishedAt),
    );
    yield* until(
      awaitEntry(bot.id, "work-fold").pipe(Effect.map((found) => found.status._tag === "finished")),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The kinds of notice the bot's conversation shows, oldest first. */
const noticesOf = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) => (entry._tag === "notice" ? [entry.notice._tag] : [])),
    ),
  );

const usageLimit = (at: DateTime.Utc) =>
  ({
    outcome: {
      _tag: "failed",
      failure: "usage-limit",
      retryAt: DateTime.addDuration(at, Duration.hours(1)),
    },
    continuation: { resumesAt: DateTime.addDuration(at, Duration.hours(1)) },
  }) as const;

it.effect("cancels a steer the engine dropped after its send's reply was lost", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Review the PR.");
    yield* nextTurn(bot.id);

    const sending = yield* control.holdNext("dispatch");
    const steer = yield* sendToBot(bot.id, "Also check the tests.");
    yield* sending.entered;
    yield* control.loseNextReply;
    yield* sending.release;
    yield* gateSettled(bot.id);

    // Stopped from the engine's own console: the drop names the turn the
    // steer was to ride, which the lost reply never did.
    yield* (yield* Engine).stop({ key: IdempotencyKey.make("console-stop"), sessionId: session });
    yield* deliveryIs(steer, "cancelled");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Also check the tests."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "leaves a steer open when the turn it rides says it is done, and cancels it on Stop",
  () =>
    Effect.gen(function* () {
      const { control, bot, session, turnId, steer } = yield* steering;
      const args = { text: "The review is done.", done: true };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "now",
      });
      const reply = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.strictEqual(reply._tag, "result");

      // `done` closed the turn's own delivery; the steer had not been read.
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
      yield* deliveryIs(steer, "cancelled");
      yield* turnEnded(bot.id);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("follows a usage-limit continuation to the turn that resumes it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const states = yield* BotStates;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Translate the docs.");
    const first = yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId: first,
      ...usageLimit(yield* DateTime.now),
    });
    yield* until(states.of(bot.id).pipe(Effect.map((state) => state._tag === "blocked")));

    const resumed = yield* control.resumeContinuation({ sessionId: session, turnId: first });
    yield* nextTurn(bot.id, first);
    yield* control.finishTurn({
      sessionId: session,
      turnId: resumed,
      outcome: { _tag: "completed" },
    });
    // The chain delivered the message; the limit it waited on was no failure.
    const followUp = yield* nextTurn(bot.id, resumed);
    yield* deliveryIs(message, "delivered");
    yield* control.finishTurn({
      sessionId: session,
      turnId: followUp,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    assert.notInclude(yield* noticesOf(bot.id), "turn-failed");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("settles a turn whose continuation the engine dropped, with a retryable notice", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Translate the docs.");
    const first = yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId: first,
      ...usageLimit(yield* DateTime.now),
    });
    yield* turnEnded(bot.id);

    yield* control.dropContinuation({ sessionId: session, turnId: first });
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "usage-limit" });
    assert.isTrue(notice.retryable);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends the operator's message while a continuation is pending", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Translate the docs.");
    const first = yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId: first,
      ...usageLimit(yield* DateTime.now),
    });
    yield* turnEnded(bot.id);

    const message = yield* sendToBot(bot.id, "Skip the appendix.");
    yield* nextTurn(bot.id, first);
    yield* deliveryIs(message, "delivered");
    const sent = (yield* control.dispatches(session)).filter((dispatch) =>
      dispatch.text.includes("Skip the appendix."),
    );
    assert.deepStrictEqual(
      sent.map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps an answered card and follows a continuation when the whole transition happened offline",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const engine = yield* Engine;
      const firstRun = Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        const session = yield* engineSession(bot.id);
        const message = yield* sendToBot(bot.id, "Publish the package.");
        const turnId = yield* nextTurn(bot.id);
        const requestId = yield* control.openRequest({
          sessionId: session,
          turnId,
          request: {
            _tag: "secret",
            label: "npm token",
            reason: "To publish.",
            url: null,
            placeholder: null,
          },
        });
        yield* awaitEntry(bot.id, "secret-request");
        return { bot, session, message, turnId, requestId };
      });
      const { bot, session, message, turnId, requestId } = yield* firstRun.pipe(
        Effect.provide(Domain.layer),
      );

      // While the server is down the operator answers in the engine's own
      // console, the turn hits its usage limit, the engine resumes it, and
      // the engine forgets the history the server's cursor names.
      yield* engine.respondSecret({
        sessionId: session,
        requestId,
        answer: { _tag: "provide", value: Redacted.make("npm_token") },
      });
      yield* control.finishTurn({ sessionId: session, turnId, ...usageLimit(yield* DateTime.now) });
      const resumed = yield* control.resumeContinuation({ sessionId: session, turnId });
      yield* control.finishTurn({
        sessionId: session,
        turnId: resumed,
        outcome: { _tag: "completed" },
      });
      yield* control.pruneHistory(session);

      yield* Effect.gen(function* () {
        const card = yield* awaitEntry(bot.id, "secret-request");
        yield* until(
          awaitEntry(bot.id, "secret-request").pipe(
            Effect.map((found) => found.status !== "pending"),
          ),
        );
        assert.strictEqual((yield* awaitEntry(bot.id, "secret-request")).status, "provided");
        assert.strictEqual(card.id, (yield* awaitEntry(bot.id, "secret-request")).id);
        // The continued turn is followed up once, as any turn that said nothing.
        const followUp = yield* nextTurn(bot.id, resumed);
        yield* deliveryIs(message, "delivered");
        yield* control.finishTurn({
          sessionId: session,
          turnId: followUp,
          outcome: { _tag: "completed" },
        });
        yield* turnEnded(bot.id);
        assert.notInclude(yield* noticesOf(bot.id), "turn-failed");
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("shows the newest running step of parallel steps, and a stall that activity ends", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const states = yield* BotStates;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Run the checks.");
    const turnId = yield* nextTurn(bot.id);
    const at = yield* DateTime.now;
    const step = (id: string, label: string, status: "running" | "completed") =>
      control.step({
        sessionId: session,
        turnId,
        step: {
          id: WorkStepId.make(id),
          kind: "command",
          label,
          status,
          startedAt: at,
          finishedAt: status === "completed" ? at : null,
        },
      });
    const activity = states
      .of(bot.id)
      .pipe(Effect.map((state) => (state._tag === "working" ? state.activity : undefined)));

    yield* step("tests", "npm test", "running");
    yield* step("lint", "npm run lint", "running");
    yield* until(activity.pipe(Effect.map((label) => label === "npm run lint")));
    yield* step("lint", "npm run lint", "completed");
    yield* until(activity.pipe(Effect.map((label) => label === "npm test")));

    // Quiet for longer than a stall takes, then a tool call: not stalled.
    yield* TestClock.adjust(Duration.sum(STALL_AFTER, Duration.minutes(1)));
    yield* until(
      states.of(bot.id).pipe(Effect.map((state) => state._tag === "working" && state.stalled)),
    );
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: { text: "Still running." },
      recorded: "now",
    });
    yield* until(
      states.of(bot.id).pipe(Effect.map((state) => state._tag === "working" && !state.stalled)),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("retries a held queue's resume whose reply was lost", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Build it.");
    yield* nextTurn(bot.id);
    yield* control.startEngineTurn(session);

    // The engine applies the resume, and its reply is lost.
    const resuming = yield* control.holdNext("resumeQueue");
    yield* control.holdQueue({ sessionId: session, heldAgainOnResume: false });
    yield* resuming.entered;
    yield* control.loseNextReply;
    yield* resuming.release;
    const resumed = sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM sessions
      WHERE queue_held_cursor IS NOT NULL AND queue_resumed_cursor = queue_held_cursor
    `.pipe(Effect.map(([row]) => (row?.n ?? 0) > 0));
    yield* gateSettled(bot.id);
    assert.isFalse(yield* resumed);

    // Once the backoff passes it is resumed again, which the engine applies once.
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* (yield* HeldQueues).resumePending;
    assert.isTrue(yield* resumed);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("forgets a hold that the engine's replaced history no longer shows", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const holdOf = (botId: BotId) =>
      sql<{ readonly cursor: string | null }>`
        SELECT queue_held_cursor AS cursor FROM sessions WHERE bot_id = ${botId}
      `.pipe(Effect.map(([row]) => row?.cursor ?? null));

    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Build it.");
      const running = yield* nextTurn(bot.id);
      yield* control.startEngineTurn(session);

      // The engine holds the queue, and the server goes down while its
      // resume is still on the way.
      const resuming = yield* control.holdNext("resumeQueue");
      yield* control.holdQueue({ sessionId: session, heldAgainOnResume: false });
      yield* resuming.entered;
      const hold = yield* holdOf(bot.id);
      return { bot, session, running, hold };
    });
    const { bot, session, running, hold } = yield* firstRun.pipe(Effect.provide(Domain.layer));
    assert.isNotNull(hold);

    // Meanwhile the queue is resumed from elsewhere, and the engine forgets
    // the events that showed the hold.
    if (hold !== null) {
      yield* (yield* Engine).resumeQueue({ sessionId: session, hold: EventCursor.make(hold) });
    }
    yield* control.finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "completed" },
    });
    yield* control.pruneHistory(session);

    yield* Effect.gen(function* () {
      yield* nextTurn(bot.id, running);
      // The replacement shows nothing held: the hold recorded before is stale.
      assert.isNull(yield* holdOf(bot.id));
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("shows an event that cannot be applied once, and applies it when it can", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Run the checks.");
    const turnId = yield* nextTurn(bot.id);

    yield* sql`
      CREATE TRIGGER poison BEFORE INSERT ON work_steps BEGIN SELECT RAISE(ABORT, 'poison'); END
    `;
    const at = yield* DateTime.now;
    yield* control.step({
      sessionId: session,
      turnId,
      step: {
        id: WorkStepId.make("step-1"),
        kind: "command",
        label: "npm test",
        status: "running",
        startedAt: at,
        finishedAt: null,
      },
    });
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "observation-failed" });

    // Read again on each reopening, and shown once.
    yield* TestClock.adjust(Duration.seconds(2));
    yield* TestClock.adjust(Duration.seconds(4));
    yield* sql`DROP TRIGGER poison`;
    yield* TestClock.adjust(Duration.seconds(8));
    yield* until(
      (yield* BotStates).of(bot.id).pipe(Effect.map((state) => state._tag === "working")),
    );
    assert.deepStrictEqual(yield* noticesOf(bot.id), ["observation-failed"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);
