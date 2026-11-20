// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Domain from "../domain.ts";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
  until,
} from "../testing/turns.ts";
import { Cards } from "./Cards.ts";

const value = { _tag: "provide", value: Redacted.make("test-token") } as const;

/**
 * A secret card, and the server stopped after writing its submission marker:
 * whether the engine got the value is for the next run to learn.
 */
const submittedThenStopped = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const sql = yield* SqlClient.SqlClient;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Publish the package.");
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
  const card = yield* awaitEntry(bot.id, "secret-request");
  yield* sql`
    INSERT INTO secret_submissions (entry_id, submitted_at)
    VALUES (${card.id}, ${timeText(yield* DateTime.now)})
  `;
  return { bot, session, requestId, card };
});

const secretStatus = (botId: BotId) =>
  awaitEntry(botId, "secret-request").pipe(Effect.map((card) => card.status));

it.effect("learns after a restart that a submission landed, and sends no second value", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const engine = yield* Engine;
    const { bot, session, requestId, card } = yield* submittedThenStopped.pipe(
      Effect.provide(Domain.layer),
    );
    // The submission in flight reached the engine while the server was down.
    yield* engine.respondSecret({ sessionId: session, requestId, answer: value });

    yield* Effect.gen(function* () {
      yield* until(secretStatus(bot.id).pipe(Effect.map((status) => status === "provided")));
      const again = yield* (yield* Cards)
        .provideSecret({ entryId: card.id, answer: value })
        .pipe(Effect.exit);
      assert.deepStrictEqual(
        Exit.findErrorOption(again).pipe(
          Option.map((error) => (error._tag === "Conflict" ? error.reason : error._tag)),
        ),
        Option.some("card-closed"),
      );
      assert.strictEqual((yield* control.secretAnswers(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("takes a value again after a restart when the submission never landed", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, session, card } = yield* submittedThenStopped.pipe(Effect.provide(Domain.layer));

    yield* Effect.gen(function* () {
      yield* (yield* Cards).provideSecret({ entryId: card.id, answer: value });
      yield* until(secretStatus(bot.id).pipe(Effect.map((status) => status === "provided")));
      assert.strictEqual((yield* control.secretAnswers(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);
