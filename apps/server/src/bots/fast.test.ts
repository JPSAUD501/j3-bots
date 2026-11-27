// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { EffortLevel, Invalid } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as TestDomain from "../testing/domain.ts";
import { command, createNewBot, engineSession, finishRunning } from "../testing/turns.ts";
import { Bots } from "./Bots.ts";

// The test engine's Claude Opus has a fast mode; its GPT has none (`TestDomain`).
const max = EffortLevel.make("max");

it.effect("creates a bot with the effort and fast mode chosen with its model, and runs them", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bots = yield* Bots;
    const bot = yield* bots.create({
      commandId: command(),
      draft: { name: "Ana", model: TestDomain.DEFAULT_MODEL, effort: max, fast: true },
    });
    assert.strictEqual(bot.effort, max);
    assert.isTrue(bot.fast);
    yield* finishRunning(bot.id);
    const session = yield* engineSession(bot.id);
    assert.strictEqual(yield* control.sessionEffort(session), max);
    assert.isTrue(yield* control.sessionFast(session));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses fast mode for a model without it, at creation and after", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const refused = yield* bots
      .create({
        commandId: command(),
        draft: { name: "Ana", model: TestDomain.OTHER_PROVIDER_MODEL, fast: true },
      })
      .pipe(Effect.flip);
    assert.deepStrictEqual(refused, new Invalid({ reason: "model" }));

    const bot = yield* createNewBot("Bruno", TestDomain.OTHER_PROVIDER_MODEL);
    const later = yield* bots
      .update({ commandId: command(), botId: bot.id, changes: { fast: true } })
      .pipe(Effect.flip);
    assert.deepStrictEqual(later, new Invalid({ reason: "model" }));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("turns fast mode off when the bot moves to a model without it", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const bot = yield* createNewBot("Ana", TestDomain.DEFAULT_MODEL);
    yield* bots.update({ commandId: command(), botId: bot.id, changes: { fast: true } });
    const moved = yield* bots.update({
      commandId: command(),
      botId: bot.id,
      changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
    });
    assert.isFalse(moved.fast);
  }).pipe(Effect.provide(TestDomain.layer)),
);
