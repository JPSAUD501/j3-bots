// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { WorkStepId } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
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
import { BotStates } from "./BotStates.ts";
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
