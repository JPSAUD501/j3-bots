// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createBot, engineSession, nextTurn, sendToBot } from "../testing/turns.ts";
import { RunningWork } from "./RunningWork.ts";

it.effect(
  "counts a bot's work on the provider its session runs on, not the one its model moved to",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const running = yield* RunningWork;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Start the dev server.");
      const turnId = yield* nextTurn(bot.id);
      // Work the move's Stop does not reach, so the old session runs on.
      yield* control.startBackgroundWork({ sessionId: session, turnId, stoppable: false });

      yield* (yield* Bots).update({
        commandId: command(),
        botId: bot.id,
        changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
      });
      assert.deepStrictEqual(yield* running.botsOn(TestDomain.DEFAULT_MODEL.providerId), [bot.id]);
      assert.deepStrictEqual(yield* running.botsOn(TestDomain.OTHER_PROVIDER_MODEL.providerId), []);
    }).pipe(Effect.provide(TestDomain.layer)),
);
