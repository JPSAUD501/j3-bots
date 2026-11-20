// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { SessionId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Domain from "../domain.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  gateSettled,
  nextTurn,
  roomOf,
  sendInRoom,
  sendToBot,
  timesSent,
  turnEnded,
} from "../testing/turns.ts";
import { Stops } from "./Stops.ts";

it.effect("cancels a message whose send was lost behind a turn when Stop races it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* control.loseNextReply;
    const message = yield* sendToBot(bot.id, "Rewrite the intro.");
    yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    yield* stops.stopBot({ commandId: command(), botId: bot.id });

    // The engine had queued it: Stop cancels it there, and the server learns so from events.
    yield* deliveryIs(message, "cancelled");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Rewrite the intro."), 1);

    // Once the Stop is confirmed the bot takes work again.
    const after = yield* sendToBot(bot.id, "Now the outro.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a Stop left unconfirmed by a restart before anything new reaches the session",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const firstRun = Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        const session = yield* engineSession(bot.id);
        const first = yield* sendToBot(bot.id, "Start the migration.");
        const running = yield* nextTurn(bot.id);
        yield* deliveryIs(first, "delivered");

        // The engine goes away before the Stop reaches it, and the operator writes again.
        yield* control.setReachable(false);
        yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
        const next = yield* sendToBot(bot.id, "Then roll it back.");
        yield* flushed(bot.id);
        return { bot, session, running, next };
      });
      const { bot, session, running, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

      yield* control.setReachable(true);
      yield* Effect.gen(function* () {
        // Had the new message gone first, it would have steered the turn the Stop ends.
        const started = yield* nextTurn(bot.id, running);
        yield* deliveryIs(next, "delivered");
        const received = yield* control.dispatches(session);
        const sent = received.filter((dispatch) => dispatch.text.includes("Then roll it back."));
        assert.deepStrictEqual(
          sent.map((dispatch) => dispatch.delivery),
          [{ _tag: "start", freshContext: false }],
        );
        yield* control.finishTurn({
          sessionId: session,
          turnId: started,
          outcome: { _tag: "completed" },
        });
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/** What the engine received carrying `text`, as the server sent it. */
const deliveriesOf = (session: SessionId, text: string) =>
  Effect.gen(function* () {
    const received = yield* (yield* TestEngineControl).dispatches(session);
    return received
      .filter((dispatch) => dispatch.text.includes(text))
      .map((dispatch) => dispatch.delivery._tag);
  });

it.effect(
  "confirms a Stop from the events after its acknowledgment, not from the acknowledgment",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const firstRun = Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        const session = yield* engineSession(bot.id);
        yield* sendToBot(bot.id, "Start the import.");
        const running = yield* nextTurn(bot.id);

        // The Stop cannot reach the engine, and the turn ends on its own.
        yield* control.setReachable(false);
        yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
        yield* control.finishTurn({
          sessionId: session,
          turnId: running,
          outcome: { _tag: "completed" },
        });
        yield* turnEnded(bot.id);
        const next = yield* sendToBot(bot.id, "Then check the totals.");
        yield* flushed(bot.id);
        return { bot, session, next };
      });
      const { bot, session, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

      // While the server is down, background work starts a turn the server has
      // not seen; when the Stop arrives its interrupt is slow.
      yield* control.setReachable(true);
      const background = yield* control.startEngineTurn(session);
      yield* control.delayNextStopEffects;

      yield* Effect.gen(function* () {
        const started = yield* nextTurn(bot.id, background);
        yield* deliveryIs(next, "delivered");
        // Confirming on the acknowledgment would have steered it into the
        // background turn the Stop was still ending.
        assert.deepStrictEqual(yield* deliveriesOf(session, "Then check the totals."), ["start"]);
        yield* control.finishTurn({
          sessionId: session,
          turnId: started,
          outcome: { _tag: "completed" },
        });
        yield* turnEnded(bot.id);
        yield* gateSettled(bot.id);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("sends the latest round of a Stop again after a restart, and confirms it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Build the index.");
      const running = yield* nextTurn(bot.id);
      const waiting = yield* control.startEngineTurn(session);

      // The first round is acknowledged, and its interrupt never comes.
      yield* control.delayNextStopEffects;
      const stops = yield* Stops;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* gateSettled(bot.id);
      yield* stops.runPending;

      // The turn ends on its own and the waiting one starts: a second round
      // is opened for it, which the engine, gone again, never receives.
      yield* control.setReachable(false);
      yield* control.finishTurn({
        sessionId: session,
        turnId: running,
        outcome: { _tag: "completed" },
      });
      yield* nextTurn(bot.id, running);
      const next = yield* sendToBot(bot.id, "Then rebuild the cache.");
      yield* flushed(bot.id);
      return { bot, session, waiting, next };
    });
    const { bot, session, waiting, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    yield* control.setReachable(true);
    yield* Effect.gen(function* () {
      const started = yield* nextTurn(bot.id, waiting);
      yield* deliveryIs(next, "delivered");
      assert.deepStrictEqual(yield* deliveriesOf(session, "Then rebuild the cache."), ["start"]);
      yield* control.finishTurn({
        sessionId: session,
        turnId: started,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
      yield* gateSettled(bot.id);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("ends the private work in a session when its room is archived", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // Background work starts a private turn while the room's message is on
    // its way: the engine queues the room's turn behind it.
    yield* control.startEngineTurnDuringNextDispatch(session);
    const inRoom = yield* sendInRoom(bot.id, room.id, "Plan the launch.");
    const background = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });
    const meanwhile = yield* sendToBot(bot.id, "What is left today?");

    // The engine's Stop ends the whole session: the room's turn is cancelled
    // and the private turn is interrupted, and the private message goes after.
    yield* deliveryIs(inRoom, "cancelled");
    const started = yield* nextTurn(bot.id, background);
    yield* deliveryIs(meanwhile, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "What is left today?"), ["start"]);
    assert.isFalse(yield* control.backgroundWorkRunning(session));
    yield* control.finishTurn({
      sessionId: session,
      turnId: started,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);
