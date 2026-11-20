// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
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
