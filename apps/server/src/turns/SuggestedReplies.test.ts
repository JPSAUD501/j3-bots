// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type BotId, MAX_SUGGESTED_REPLY_LENGTH } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { BotStore } from "../bots/BotStore.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  type Member,
  member,
  operatorWrites,
  roomWith,
  say,
  to,
} from "../testing/rooms.ts";
import {
  command,
  conversation,
  eventually,
  flushed,
  messageTeammate,
  nextTurn,
  sendToBot,
  until,
} from "../testing/turns.ts";
import { offerableText } from "./SuggestedReplies.ts";

// A reply the AI suggests is offered in the bot's conversation only after a
// turn the operator woke there, while what the bot answered is the newest
// message (`docs/architecture/server.md`, Suggested replies).

const offered = (botId: BotId) =>
  Effect.gen(function* () {
    const found = yield* (yield* BotStore).find(botId);
    return Option.getOrThrow(found).bot.suggestedReply;
  });

const offeredIs = (botId: BotId, text: string | null) =>
  until(Effect.map(offered(botId), (reply) => (reply?.text ?? null) === text));

/** The engine's guess after the turn, in the member's session. */
const guess = (scout: Member, turnId: TurnId, text: string) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).suggestReply({
      sessionId: scout.session,
      reply: { turnId, text },
    });
  });

/**
 * Lets the server weigh a guess it should not offer: nothing it does then
 * shows, so the test waits a moment in real time before it looks.
 */
const weighed = Effect.sleep("100 millis").pipe(
  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
);

/** The operator asks Scout something, and Scout answers in a turn that ends. */
const answered = (scout: Member, question: string, answer: string, previous: TurnId | null) =>
  Effect.gen(function* () {
    yield* sendToBot(scout.bot.id, question);
    yield* flushed(scout.bot.id);
    const turnId = yield* nextTurn(scout.bot.id, previous);
    yield* say(scout, turnId, { text: answer, done: true });
    return turnId;
  });

describe("suggested replies", () => {
  it.effect("follow the bot's answer to the operator, until something newer is said", () =>
    Effect.gen(function* () {
      const scout = yield* member("Scout");
      const turnId = yield* answered(scout, "What's on today?", "Two meetings.", null);
      // The harness may guess before the server saw the turn end.
      yield* guess(scout, turnId, "  Move the second one to Friday  ");
      yield* finish(scout, turnId, [scout]);

      const reply = yield* eventually(Effect.map(offered(scout.bot.id), Option.fromNullishOr));
      const answer = (yield* conversation(scout.bot.id)).at(-1);
      assert.deepStrictEqual(reply, { text: "Move the second one to Friday", after: answer?.id });

      yield* sendToBot(scout.bot.id, "Thanks!");
      yield* offeredIs(scout.bot.id, null);
    }).pipe(Effect.provide(TestDomain.layer)),
  );

  it.effect("are never offered for a room's turn", () =>
    Effect.gen(function* () {
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      const own = yield* answered(scout, "What's on today?", "Two meetings.", null);
      yield* finish(scout, own, [scout]);
      yield* guess(scout, own, "Move the second one");
      yield* offeredIs(scout.bot.id, "Move the second one");

      // The same session answers in the room, and the harness guesses again.
      const room = yield* roomWith(scout, [wren]);
      yield* operatorWrites(room.id, [scout, wren], "Scout, what did we decide?", to(scout));
      const roomTurn = yield* nextTurn(scout.bot.id, own);
      yield* say(scout, roomTurn, { text: "Friday launch.", done: true });
      yield* finish(scout, roomTurn, [scout, wren]);
      yield* guess(scout, roomTurn, "Tell Wren too");
      yield* offeredIs(scout.bot.id, null);
    }).pipe(Effect.provide(TestDomain.layer)),
  );

  it.effect("are never offered for a teammate's turn the operator steered", () =>
    Effect.gen(function* () {
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      yield* sendToBot(wren.bot.id, "Ask Scout what is left.");
      const asked = yield* nextTurn(wren.bot.id);
      yield* messageTeammate(wren.session, asked, {
        to: scout.bot.id,
        text: "What is left?",
        urgent: true,
      });
      yield* finish(wren, asked, [wren]);

      // Scout answers its teammate, and the operator's word is steered in.
      const teammateTurn = yield* nextTurn(scout.bot.id);
      yield* sendToBot(scout.bot.id, "And tell me when it is done.");
      yield* flushed(scout.bot.id);
      yield* (yield* TestEngineControl).readSteers({
        sessionId: scout.session,
        turnId: teammateTurn,
      });
      yield* say(scout, teammateTurn, { text: "Only the invoices are left.", done: true });
      yield* finish(scout, teammateTurn, [scout]);
      yield* guess(scout, teammateTurn, "Thanks, Wren");
      yield* weighed;
      assert.isNull(yield* offered(scout.bot.id));
    }).pipe(Effect.provide(TestDomain.layer)),
  );

  it.effect("are offered only while the operator's switch is on", () =>
    Effect.gen(function* () {
      const scout = yield* member("Scout");
      const turnId = yield* answered(scout, "What's on today?", "Two meetings.", null);
      yield* finish(scout, turnId, [scout]);
      yield* guess(scout, turnId, "Move the second one");
      yield* offeredIs(scout.bot.id, "Move the second one");

      const settings = yield* SettingsService;
      yield* settings.update({ commandId: command(), changes: { suggestReplies: false } });
      yield* offeredIs(scout.bot.id, null);
      yield* settings.update({ commandId: command(), changes: { suggestReplies: true } });
      yield* offeredIs(scout.bot.id, "Move the second one");
    }).pipe(Effect.provide(TestDomain.layer)),
  );
});

describe("a guess's text", () => {
  it("is offered trimmed, and never when it reads as an envelope or runs too long", () => {
    assert.strictEqual(offerableText("  Sounds good  "), "Sounds good");
    assert.isNull(offerableText("   "));
    assert.isNull(offerableText('<j3-wake kind="user">Sounds good'));
    assert.isNull(offerableText(`<message from="user">Sounds good</message>`));
    assert.strictEqual(offerableText("Is 2 < 3?"), "Is 2 < 3?");
    assert.isNull(offerableText("a".repeat(MAX_SUGGESTED_REPLY_LENGTH + 1)));
  });
});
