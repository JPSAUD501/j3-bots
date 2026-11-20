// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { NO_TURN_REFUSAL } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Attachments } from "../attachments/Attachments.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  admittedTurn,
  awaitEntry,
  command,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  nextTurn,
  roomOf,
  sendInRoom,
  sendToBot,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { BotStates } from "./BotStates.ts";
import { Cards } from "./Cards.ts";

/** What the bot said in its conversation, oldest first. */
const botSaid = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry._tag === "message" && entry.author._tag === "bot" ? [entry.text] : [],
      ),
    ),
  );

/** The bot is working on a message from the operator. */
const working = (text: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, text);
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, message, turnId };
  });

it.effect(
  "records a say the engine records late, and lets a done say end delivery without ending the run",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const tools = yield* BotTools;
      const { bot, session, message, turnId } = yield* working("Write the summary.");
      const args = { text: "The summary is in files/summary.md.", done: true };

      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "after-next-synchronize",
      });
      const reply = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.deepStrictEqual(reply, { _tag: "result", value: { status: "recorded" } });

      // A forward repeated by the bridge returns the first result; another request for the one call is refused.
      const repeated = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.deepStrictEqual(repeated, reply);
      const duplicate = yield* tools.call({
        requestId: "call-2",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.strictEqual(duplicate._tag, "refused");

      assert.deepStrictEqual(yield* botSaid(bot.id), ["The summary is in files/summary.md."]);
      yield* deliveryIs(message, "delivered");
      assert.isTrue(Option.isSome(yield* admittedTurn(bot.id)));

      yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
      yield* turnEnded(bot.id);
      yield* flushed(bot.id);
      // It delivered: no follow-up asks the bot to say something.
      assert.strictEqual((yield* control.dispatches(session)).length, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

// An ACP agent can report a call before its arguments: the engine records
// it with `{}`, then again with the arguments the bridge receives.
it.effect("matches a call the engine recorded again with its arguments", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, message, turnId } = yield* working("Check the build.");
    const args = { text: "The build is green.", done: true };

    const callId = yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: {},
      recorded: "now",
    });
    yield* control.recordToolInput({ sessionId: session, turnId, callId, input: args });
    const reply = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    assert.deepStrictEqual(reply, { _tag: "result", value: { status: "recorded" } });
    assert.deepStrictEqual(yield* botSaid(bot.id), ["The build is green."]);
    yield* deliveryIs(message, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a call of a turn that ended, even one the next turn could match", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, turnId } = yield* working("Check the build.");
    const args = { text: "The build is green." };

    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    // The turn delivered nothing, so J3 Bots follows it up with a turn of its own.
    yield* nextTurn(bot.id, turnId);

    const late = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    assert.deepStrictEqual(late, { _tag: "refused", message: NO_TURN_REFUSAL });
    assert.deepStrictEqual(yield* botSaid(bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("closes delivery with an ask card, whose answer wakes the bot", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const cards = yield* Cards;
    const states = yield* BotStates;
    const { bot, session, turnId } = yield* working("Deploy it.");
    const args = {
      prompt: "Which region?",
      options: [{ label: "Europe", value: "eu-west-1" }, { label: "United States" }],
    };

    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    const reply = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "ask",
      arguments: args,
    });
    assert.strictEqual(reply._tag, "result");
    const card = yield* awaitEntry(bot.id, "question");
    assert.strictEqual(card.origin, "ask");
    assert.deepStrictEqual(card.status, { _tag: "pending" });

    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    // The card delivered the turn: the bot waits on it, with no follow-up.
    assert.strictEqual((yield* control.dispatches(session)).length, 1);
    assert.deepStrictEqual(yield* states.of(bot.id), { _tag: "waiting", entryId: card.id });

    const question = card.questions[0].id;
    yield* cards.answer({
      commandId: command(),
      entryId: card.id,
      answer: {
        _tag: "question",
        answers: { [question]: { optionIds: ["option-1"], text: null } },
      },
    });
    yield* nextTurn(bot.id, turnId);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
    yield* until(
      awaitEntry(bot.id, "question").pipe(Effect.map((found) => found.status._tag === "answered")),
    );

    const again = yield* cards
      .answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } })
      .pipe(Effect.exit);
    assert.deepStrictEqual(
      Exit.findErrorOption(again).pipe(Option.map((error) => error._tag)),
      Option.some("Conflict"),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a say to the operator from a turn whose room was archived, storing none of its files",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const tools = yield* BotTools;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const room = yield* roomOf(bot.id);
      yield* sendInRoom(bot.id, room.id, "Plan the launch.");
      const turnId = yield* nextTurn(bot.id);

      const workspace = Option.getOrThrow(yield* (yield* BotStore).find(bot.id)).workspacePath;
      yield* fs.makeDirectory(path.join(workspace, "files"), { recursive: true });
      yield* fs.writeFileString(path.join(workspace, "files", "plan.md"), "The plan.");
      const args = { text: "Here is the plan.", to: "dm", attachments: ["files/plan.md"] };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "now",
      });

      // The room is archived while its turn is still being stopped.
      yield* control.delayNextStopEffects;
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { archived: true },
      });
      const reply = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });

      assert.strictEqual(reply._tag, "refused");
      assert.deepStrictEqual(yield* botSaid(bot.id), []);
      const stored = yield* (yield* Attachments).botFiles({
        botId: bot.id,
        before: null,
        limit: 10,
      });
      assert.deepStrictEqual(stored.files, []);
    }).pipe(Effect.provide(TestDomain.layer)),
);
