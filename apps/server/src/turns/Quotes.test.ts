// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type Entry,
  EntryId,
  type EntryTarget,
  Invalid,
  type MessageQuote,
  type Mentions,
  QUOTE_OPENING_LENGTH,
  type QuoteRequest,
} from "@j3-bots/contracts";
import { QUOTES_LINE } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  lastEnvelope,
  member,
  nobody,
  roomEntries,
  roomWakesOf,
  roomWith,
  say,
  settle,
  to,
} from "../testing/rooms.ts";
import {
  command,
  concurrentTurns,
  conversation,
  flushed,
  nextTurn,
  received,
} from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { Pipeline } from "./Pipeline.ts";

/** The operator writes `text` to `target`, quoting `quotes`. */
const write = (
  target: EntryTarget,
  text: string,
  quotes: ReadonlyArray<QuoteRequest> = [],
  mentions?: Mentions,
) =>
  Effect.gen(function* () {
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target,
      text,
      attachments: [],
      ...(quotes.length === 0 ? {} : { quotes }),
      ...(mentions === undefined ? {} : { mentions }),
    });
  });

/** What the message `id` of `entries` quotes. */
const quotesOf = (
  entries: ReadonlyArray<Entry>,
  id: EntryId,
): ReadonlyArray<MessageQuote> | undefined => {
  const found = entries.find((entry) => entry.id === id);
  return found?._tag === "message" ? found.quotes : undefined;
};

const refusedWith = (response: ToolCallResponse) =>
  response._tag === "refused" ? response.message : "";

it.effect(
  "keeps what a message quotes of its conversation, and refuses any other quote, writing nothing",
  () =>
    Effect.gen(function* () {
      const [ana, bia] = yield* Effect.all([member("Ana"), member("Bia")]);
      const toAna: EntryTarget = { _tag: "conversation", botId: ana.bot.id };
      const long = `${"word ".repeat(80)}end`;
      const options = yield* write(toAna, "Two options: alpha, or beta.");
      const report = yield* write(toAna, long);
      const elsewhere = yield* write({ _tag: "conversation", botId: bia.bot.id }, "alpha");

      const id = yield* write(toAna, "Go with this.", [
        { entryId: report },
        { entryId: options, passage: "alpha" },
        { entryId: options, passage: "beta", comment: "Cheaper, I think." },
      ]);
      const quotes = quotesOf(yield* conversation(ana.bot.id), id);
      assert.deepStrictEqual(
        quotes?.map((quote) => quote.comment),
        [undefined, undefined, "Cheaper, I think."],
      );
      assert.deepStrictEqual(
        quotes?.map((quote) => [quote.entryId, quote.author._tag, quote.quoted]),
        [
          [
            report,
            "operator",
            {
              _tag: "message",
              opening: long.slice(0, QUOTE_OPENING_LENGTH).trimEnd(),
              more: true,
            },
          ],
          [options, "operator", { _tag: "passage", text: "alpha" }],
          [options, "operator", { _tag: "passage", text: "beta" }],
        ],
      );

      const before = (yield* conversation(ana.bot.id)).length;
      const outcomes = yield* Effect.forEach(
        [
          // Words the message does not have.
          [{ entryId: options, passage: "gamma" }],
          // A passage that is not trimmed.
          [{ entryId: options, passage: " alpha" }],
          // A message of another conversation.
          [{ entryId: elsewhere, passage: "alpha" }],
          // A message nobody wrote.
          [{ entryId: EntryId.make("nothing") }],
          // Two replies.
          [{ entryId: options }, { entryId: report }],
          // The same quote twice.
          [
            { entryId: options, passage: "alpha" },
            { entryId: options, passage: "alpha" },
          ],
          // A comment on a reply, which is the message itself.
          [{ entryId: options, comment: "This one." }],
        ],
        (quotes: ReadonlyArray<QuoteRequest>) => Effect.flip(write(toAna, "hi", quotes)),
      );
      for (const error of outcomes)
        assert.deepStrictEqual(error, new Invalid({ reason: "quotes" }));
      assert.strictEqual((yield* conversation(ana.bot.id)).length, before);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the bot each quote after the message, as what someone said then, and the operator's comment in it",
  () =>
    Effect.gen(function* () {
      const ana = yield* member("Ana");
      const toAna: EntryTarget = { _tag: "conversation", botId: ana.bot.id };
      const options = yield* write(toAna, "Two options: alpha, or beta.");
      yield* flushed(ana.bot.id);
      const first = yield* nextTurn(ana.bot.id);
      yield* finish(ana, first, [ana]);

      yield* write(toAna, "This one, please.", [
        { entryId: options, passage: "alpha" },
        { entryId: options, passage: "beta", comment: "Cheaper, I think." },
      ]);
      yield* flushed(ana.bot.id);
      const envelope = (yield* received(ana.session)).at(-1)?.text ?? "";
      assert.include(envelope, "This one, please.");
      // The comment is the operator's word, in their message, on the second passage of the two.
      assert.match(
        envelope,
        new RegExp(
          `<message from="user"[^>]*>\\nThis one, please\\.\\n<comment quote="2">Cheaper, I think\\.</comment>\\n</message>`,
        ),
      );
      assert.include(envelope, QUOTES_LINE);
      assert.match(
        envelope,
        new RegExp(
          `<data-[0-9a-f]+ source="quote" n="2" id="${options}" from="user" at="[0-9:]+" part="passage">\\nbeta\\n</data-`,
        ),
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "in a room, a reply to a member's message wakes that member alone, unless it mentions someone; a passage wakes as any message",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = yield* Effect.all([member("Hal"), member("Ana"), member("Bo")]);
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const target: EntryTarget = { _tag: "room", roomId: room.id };
      yield* concurrentTurns(3);

      yield* write(target, "Ana, the numbers?", [], to(ana));
      yield* settle(members);
      const anaTurn = yield* nextTurn(ana.bot.id);
      yield* say(ana, anaTurn, { text: "Revenue grew 12%.", mention: [hal.bot.id] });
      const numbers = (yield* roomEntries(room.id)).at(-1)?.id;
      assert.isDefined(numbers);
      if (numbers === undefined) return;
      yield* finish(ana, anaTurn, members);
      const halTurn = yield* nextTurn(hal.bot.id);
      yield* finish(hal, halTurn, members);
      const counts = () => Effect.forEach(members, (one) => roomWakesOf(one.bot.id, room.id));
      const before = yield* counts();

      // A reply to Ana's message, mentioning nobody: Ana alone, addressed.
      yield* write(target, "Is that net?", [{ entryId: numbers }], nobody);
      yield* settle(members);
      assert.deepStrictEqual(yield* counts(), [before[0], (before[1] ?? 0) + 1, before[2]]);
      const anaAgain = yield* nextTurn(ana.bot.id, anaTurn);
      const replyEnvelope = yield* lastEnvelope(ana);
      assert.include(replyEnvelope, 'reason="addressed"');
      assert.include(replyEnvelope, 'from="you"');
      assert.include(replyEnvelope, "Revenue grew 12%.");
      yield* finish(ana, anaAgain, members);

      // Mentions win: the reply goes to Bo, whom it mentions.
      const afterReply = yield* counts();
      yield* write(target, "Bo, check it.", [{ entryId: numbers }], to(bo));
      yield* settle(members);
      assert.deepStrictEqual(yield* counts(), [
        afterReply[0],
        afterReply[1],
        (afterReply[2] ?? 0) + 1,
      ]);
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* finish(bo, boTurn, members);

      // A passage addresses nobody: every member wakes.
      const afterMention = yield* counts();
      yield* write(target, "Why so much?", [{ entryId: numbers, passage: "12%" }], nobody);
      yield* settle(members);
      assert.deepStrictEqual(
        yield* counts(),
        afterMention.map((count) => count + 1),
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "a bot's say replies to a message of where it speaks, which wakes the member it replies to in a room, and to nothing else",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = yield* Effect.all([member("Hal"), member("Ana"), member("Bo")]);
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const target: EntryTarget = { _tag: "room", roomId: room.id };
      yield* concurrentTurns(3);

      const asked = yield* write(target, "Ana, the numbers?", [], to(ana));
      yield* settle(members);
      const anaTurn = yield* nextTurn(ana.bot.id);
      // An id of another conversation, or of nothing, is refused, with nothing sent.
      const elsewhere = yield* write({ _tag: "conversation", botId: bo.bot.id }, "Hello");
      for (const id of [elsewhere, "nothing"]) {
        const refused = yield* say(ana, anaTurn, { text: "Here.", reply_to: id });
        assert.include(refusedWith(refused), "`reply_to` names no message of the room");
      }
      assert.lengthOf(yield* roomEntries(room.id), 1);

      // Ana replies to the operator's message: it wakes every other member, as before.
      const before = yield* Effect.forEach(members, (one) => roomWakesOf(one.bot.id, room.id));
      yield* say(ana, anaTurn, { text: "Revenue grew 12%.", reply_to: asked });
      const said = (yield* roomEntries(room.id)).at(-1);
      assert.deepStrictEqual(
        said?._tag === "message"
          ? said.quotes?.map((quote) => [quote.entryId, quote.author._tag, quote.quoted._tag])
          : undefined,
        [[asked, "operator", "message"]],
      );
      yield* finish(ana, anaTurn, members);
      const after = yield* Effect.forEach(members, (one) => roomWakesOf(one.bot.id, room.id));
      assert.deepStrictEqual(after, [(before[0] ?? 0) + 1, before[1], (before[2] ?? 0) + 1]);

      // Hal replies to Ana's message, mentioning nobody: it wakes Ana alone.
      const halTurn = yield* nextTurn(hal.bot.id);
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* finish(bo, boTurn, members);
      if (said === undefined) return;
      yield* say(hal, halTurn, { text: "Net or gross?", reply_to: said.id });
      yield* finish(hal, halTurn, members);
      assert.deepStrictEqual(
        yield* Effect.forEach(members, (one) => roomWakesOf(one.bot.id, room.id)),
        [after[0], (after[1] ?? 0) + 1, after[2]],
      );
      assert.include(yield* lastEnvelope(ana), 'reason="addressed"');
    }).pipe(Effect.provide(TestDomain.layer)),
);
