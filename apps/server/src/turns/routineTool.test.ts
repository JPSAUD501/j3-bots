// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { Routine, TimeZone } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Routines } from "../routines/Routines.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";

const decodeRoutine = Schema.decodeUnknownSync(Schema.toCodecJson(Routine));

/** The routine a call returned. */
const savedBy = (reply: ToolCallResponse) => {
  if (reply._tag === "refused") throw new Error(`Refused: ${reply.message}`);
  return decodeRoutine(reply.value);
};

/** The bot is working on a message from the operator, who keeps Tokyo time (UTC+9, no clock changes). */
const working = Effect.gen(function* () {
  yield* (yield* SettingsService).update({
    commandId: command(),
    changes: { timeZone: TimeZone.make("Asia/Tokyo") },
  });
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Remind me about the dentist.");
  const turnId = yield* nextTurn(bot.id);
  return { bot, session, turnId };
});

/** The bot calls `set_routine` in the turn, which the engine records first. */
const setRoutine = (
  sessionId: SessionId,
  turnId: TurnId,
  args: { readonly [key: string]: string | boolean },
  requestId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "set_routine",
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId,
      sessionId,
      tool: "set_routine",
      arguments: args,
    });
  });

it.effect(
  "creates the bot's routine with times in the operator's zone, once under a retried request",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId } = yield* working;
      const args = {
        action: "create",
        name: "Dentist",
        instruction: "Tell my user the dentist appointment is at 10:00 today.",
        at: "2030-03-04T09:00",
      };

      const reply = yield* setRoutine(session, turnId, args, "call-1");
      const created = savedBy(reply);
      assert.deepStrictEqual(created.trigger, {
        _tag: "once",
        at: DateTime.makeUnsafe("2030-03-04T00:00:00Z"),
      });
      assert.deepStrictEqual(created.nextRunAt, DateTime.makeUnsafe("2030-03-04T00:00:00Z"));

      // The bridge forwarding the request again gets the first result and acts no more.
      const repeated = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: session,
        tool: "set_routine",
        arguments: args,
      });
      assert.deepStrictEqual(repeated, reply);
      const routines = yield* (yield* Routines).list(bot.id);
      assert.deepStrictEqual(
        routines.map((routine) => routine.id),
        [created.id],
      );
      const changes = (yield* conversation(bot.id)).flatMap((entry) =>
        entry._tag === "routine-change" ? [[entry.author, entry.change]] : [],
      );
      assert.deepStrictEqual(changes, [[{ _tag: "bot", botId: bot.id }, "created"]]);

      // A new schedule is saved in the operator's zone too.
      const updated = yield* setRoutine(
        session,
        turnId,
        { action: "update", id: created.id, schedule: "30 8 * * 1-5" },
        "call-2",
      );
      assert.deepStrictEqual(savedBy(updated).trigger, {
        _tag: "schedule",
        cron: "30 8 * * 1-5",
        timeZone: "Asia/Tokyo",
      });
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a routine of another bot, and changes nothing", () =>
  Effect.gen(function* () {
    const { session, turnId } = yield* working;
    const other = yield* createBot("Bia");
    const theirs = yield* (yield* Routines).create({
      commandId: command(),
      botId: other.id,
      draft: {
        name: "Builds",
        instruction: "Check the nightly build.",
        trigger: { _tag: "webhook" },
      },
      author: { _tag: "operator" },
    });

    const reply = yield* setRoutine(session, turnId, { action: "pause", id: theirs.id }, "call-1");
    assert.strictEqual(reply._tag, "refused");
    const [after] = yield* (yield* Routines).list(other.id);
    assert.isTrue(after?.enabled);
  }).pipe(Effect.provide(TestDomain.layer)),
);
