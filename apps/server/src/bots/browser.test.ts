// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  deliveryIs,
  engineSession,
  finishRunning,
  nextTurn,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotStore } from "./BotStore.ts";
import { Bots } from "./Bots.ts";

it.effect(
  "gives a bot the browser from its next turn once the operator turns it on, and takes it away the same way",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bots = yield* Bots;
      const store = yield* BotStore;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      assert.isFalse(bot.browser);
      assert.isFalse(yield* control.sessionBrowserTools(session));

      const on = yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { browser: true },
      });
      assert.isTrue(on.browser);
      assert.isTrue(Option.getOrThrow(yield* store.find(bot.id)).bot.browser);
      const browsing = yield* sendToBot(bot.id, "Read the release notes on the site.");
      const first = yield* nextTurn(bot.id);
      assert.isTrue(yield* control.sessionBrowserTools(session));
      yield* finishRunning(bot.id);
      yield* deliveryIs(browsing, "delivered");
      yield* turnEnded(bot.id);

      const off = yield* bots.update({
        commandId: command(),
        botId: bot.id,
        changes: { browser: false },
      });
      assert.isFalse(off.browser);
      yield* sendToBot(bot.id, "Summarize them.");
      yield* nextTurn(bot.id, first);
      assert.isFalse(yield* control.sessionBrowserTools(session));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("lets a turn already running keep the tools it started with", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bots = yield* Bots;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Plan the launch.");
    const running = yield* nextTurn(bot.id);

    yield* bots.update({ commandId: command(), botId: bot.id, changes: { browser: true } });
    assert.isFalse(yield* control.sessionBrowserTools(session));
    yield* finishRunning(bot.id);
    yield* turnEnded(bot.id);

    yield* sendToBot(bot.id, "Now check the site.");
    yield* nextTurn(bot.id, running);
    assert.isTrue(yield* control.sessionBrowserTools(session));
  }).pipe(Effect.provide(TestDomain.layer)),
);
