// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { EffortLevel, Invalid } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createNewBot,
  deliveryIs,
  engineSession,
  finishRunning,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { Bots } from "./Bots.ts";

// The test engine's Claude Opus takes low, high and max; its GPT takes low,
// medium and xhigh (`TestDomain`).
const low = EffortLevel.make("low");
const max = EffortLevel.make("max");

it.effect("brings the bot's session to a new effort before its next turn, in place", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bots = yield* Bots;
    const bot = yield* createNewBot("Ana");
    const first = yield* finishRunning(bot.id);
    const session = yield* engineSession(bot.id);
    assert.isNull(yield* control.sessionEffort(session));

    const saved = yield* bots.update({
      commandId: command(),
      botId: bot.id,
      changes: { effort: max },
    });
    assert.strictEqual(saved.effort, max);
    const message = yield* sendToBot(bot.id, "Check the numbers again.");
    yield* nextTurn(bot.id, first);
    assert.strictEqual(yield* engineSession(bot.id), session);
    assert.strictEqual(yield* control.sessionEffort(session), max);
    const second = yield* finishRunning(bot.id, first);
    yield* deliveryIs(message, "delivered");

    yield* bots.update({ commandId: command(), botId: bot.id, changes: { effort: null } });
    yield* sendToBot(bot.id, "And once more.");
    yield* nextTurn(bot.id, second);
    assert.isNull(yield* control.sessionEffort(session));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes the bot back to the default effort when its new model lacks the level", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const lacking = yield* createNewBot("Ana");
    yield* bots.update({ commandId: command(), botId: lacking.id, changes: { effort: max } });
    const moved = yield* bots.update({
      commandId: command(),
      botId: lacking.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });
    assert.isNull(moved.effort);

    const sharing = yield* createNewBot("Bruno");
    yield* bots.update({ commandId: command(), botId: sharing.id, changes: { effort: low } });
    const kept = yield* bots.update({
      commandId: command(),
      botId: sharing.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });
    assert.strictEqual(kept.effort, low);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a level the bot's model does not take, saving nothing", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const bot = yield* createNewBot("Ana");
    const refused = yield* bots
      .update({
        commandId: command(),
        botId: bot.id,
        changes: { effort: EffortLevel.make("xhigh") },
      })
      .pipe(Effect.flip);
    assert.deepStrictEqual(refused, new Invalid({ reason: "model" }));
    const stored = yield* bots.update({
      commandId: command(),
      botId: bot.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL, effort: EffortLevel.make("xhigh") },
    });
    assert.strictEqual(stored.effort, "xhigh");
  }).pipe(Effect.provide(TestDomain.layer)),
);
