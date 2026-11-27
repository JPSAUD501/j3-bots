// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  type EntryId,
  type MessageEntry,
  ReactionEmoji,
  WorkStepId,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestDomain from "../testing/domain.ts";
import {
  admittedTurn,
  conversation,
  createBot,
  engineSession,
  finishRunning,
  flushed,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { REACTION_SETTLE, Reactions } from "./Reactions.ts";

// Reactions on messages (`docs/architecture/server.md`, Reactions; decision
// 0084): the operator's reaction on a bot's message wakes that bot in a
// quiet turn once it settles, unless it is busy; a bot reacts with `react`.

const emoji = Schema.decodeSync(ReactionEmoji);

/** The bot's newest message in its conversation. */
const lastSaid = (botId: BotId) =>
  Effect.map(conversation(botId), (entries) => {
    const said = entries.filter(
      (entry): entry is MessageEntry => entry._tag === "message" && entry.author._tag === "bot",
    );
    const last = said.at(-1);
    if (last === undefined) throw new Error("The bot has said nothing");
    return last;
  });

/** The operator's newest message in the bot's conversation. */
const lastWritten = (botId: BotId) =>
  Effect.map(conversation(botId), (entries) => {
    const written = entries.filter(
      (entry): entry is MessageEntry =>
        entry._tag === "message" && entry.author._tag === "operator",
    );
    const last = written.at(-1);
    if (last === undefined) throw new Error("The operator has written nothing");
    return last;
  });

/** A bot that answered the operator once, and is idle. */
const answered = Effect.gen(function* () {
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Find us a table for Friday.");
  const turn = yield* finishRunning(bot.id);
  yield* turnEnded(bot.id);
  return { bot, session, turn, message: yield* lastSaid(bot.id) };
});

/** Lets the operator's reactions settle and reach their bots. */
const settled = (botId: BotId) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(REACTION_SETTLE);
    yield* (yield* Reactions).settleDue;
    yield* flushed(botId);
  });

const envelopesWith = (session: SessionId, text: string) =>
  Effect.map(received(session), (all) => all.filter((dispatch) => dispatch.text.includes(text)));

let calls = 0;

/** The bot calls `react` in its running turn: what the tool answers. */
const botReacts = (
  session: SessionId,
  turnId: TurnId,
  input: { readonly message: EntryId; readonly emoji: string; readonly done?: boolean },
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: session,
      turnId,
      tool: "react",
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `react-${++calls}`,
      sessionId: session,
      tool: "react",
      arguments: { ...input },
    });
  });

it.effect("tells the bot once, as the reaction ended, in a quiet turn", () =>
  Effect.gen(function* () {
    const { bot, session, turn, message } = yield* answered;
    const reactions = yield* Reactions;
    yield* reactions.react({ entryId: message.id, emoji: emoji("👍") });
    yield* reactions.react({ entryId: message.id, emoji: emoji("❤️") });
    yield* settled(bot.id);

    yield* nextTurn(bot.id, turn);
    const told = yield* envelopesWith(session, "<reactions");
    assert.strictEqual(told.length, 1);
    assert.include(told[0]?.text, 'emoji="❤️"');
    assert.notInclude(told[0]?.text, 'emoji="👍"');
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves no trace of a quiet turn that ends without a word", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, session, turn, message } = yield* answered;
    const before = (yield* conversation(bot.id)).length;
    yield* (yield* Reactions).react({ entryId: message.id, emoji: emoji("👍") });
    yield* settled(bot.id);

    const quiet = yield* nextTurn(bot.id, turn);
    const at = yield* DateTime.now;
    yield* control.step({
      sessionId: session,
      turnId: quiet,
      step: {
        id: WorkStepId.make("step-1"),
        kind: "command",
        tool: null,
        label: "cat notes.md",
        status: "completed",
        startedAt: at,
        finishedAt: at,
      },
    });
    yield* control.finishTurn({
      sessionId: session,
      turnId: quiet,
      outcome: { _tag: "failed", failure: "unknown", retryAt: null },
    });
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);

    // No work fold, no notice of how it ended, and no turn after it.
    assert.strictEqual((yield* conversation(bot.id)).length, before);
    assert.isTrue(Option.isNone(yield* admittedTurn(bot.id)));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("wakes nothing for a reaction taken off before it settles", () =>
  Effect.gen(function* () {
    const { bot, session, message } = yield* answered;
    const reactions = yield* Reactions;
    const before = (yield* received(session)).length;
    yield* reactions.react({ entryId: message.id, emoji: emoji("👍") });
    yield* reactions.react({ entryId: message.id, emoji: null });
    yield* settled(bot.id);

    assert.isTrue(Option.isNone(yield* admittedTurn(bot.id)));
    assert.strictEqual((yield* received(session)).length, before);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("brings a reaction to a busy bot with its next turn", () =>
  Effect.gen(function* () {
    const { bot, session, turn, message } = yield* answered;
    yield* sendToBot(bot.id, "And for Saturday?");
    const busy = yield* nextTurn(bot.id, turn);
    yield* (yield* Reactions).react({ entryId: message.id, emoji: emoji("👍") });
    yield* settled(bot.id);
    assert.lengthOf(yield* envelopesWith(session, "<reactions"), 0);

    // The running turn ends; the reaction starts no turn of its own.
    const ended = yield* finishRunning(bot.id, turn);
    assert.strictEqual(ended, busy);
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.isTrue(Option.isNone(yield* admittedTurn(bot.id)));

    yield* sendToBot(bot.id, "Thanks.");
    yield* nextTurn(bot.id, busy);
    const told = yield* envelopesWith(session, "<reactions");
    assert.strictEqual(told.length, 1);
    assert.include(told[0]?.text, "Thanks.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("records a bot's reaction as its whole reply, and never on its own message", () =>
  Effect.gen(function* () {
    const { bot, session, turn, message } = yield* answered;
    yield* sendToBot(bot.id, "Perfect, thank you!");
    const thanks = yield* lastWritten(bot.id);
    const running = yield* nextTurn(bot.id, turn);

    const own = yield* botReacts(session, running, { message: message.id, emoji: "👍" });
    assert.strictEqual(own._tag, "refused");
    const word = yield* botReacts(session, running, { message: thanks.id, emoji: "ok" });
    assert.strictEqual(word._tag, "refused");

    const reacted = yield* botReacts(session, running, {
      message: thanks.id,
      emoji: "❤️",
      done: true,
    });
    assert.strictEqual(reacted._tag, "result");
    assert.deepStrictEqual((yield* lastWritten(bot.id)).reactions, [
      { emoji: emoji("❤️"), by: { _tag: "bot", botId: bot.id } },
    ]);

    // Its reaction is the reply: the turn ends with no reminder that it said nothing.
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.isTrue(Option.isNone(yield* admittedTurn(bot.id)));
  }).pipe(Effect.provide(TestDomain.layer)),
);
