// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type ConversationMention,
  type EntryTarget,
  Invalid,
  type Mentions,
  RoomId,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import { Rooms } from "../rooms/Rooms.ts";
import { archive, member, roomEntries, settle } from "../testing/rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, conversation, flushed, received } from "../testing/turns.ts";
import { Pipeline } from "./Pipeline.ts";

/** The operator writes `text` to `target`, naming `named`. */
const write = (
  target: EntryTarget,
  text: string,
  named: ReadonlyArray<ConversationMention>,
  mentions?: Mentions,
) =>
  Effect.gen(function* () {
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target,
      text,
      attachments: [],
      conversationMentions: named,
      ...(mentions === undefined ? {} : { mentions }),
    });
  });

const bot = (botId: BotId): ConversationMention => ({ _tag: "bot", botId });
const room = (roomId: RoomId): ConversationMention => ({ _tag: "room", roomId });

it.effect(
  "takes mentions of the operator's other bots and of the rooms the bot is in, and refuses any other, writing nothing",
  () =>
    Effect.gen(function* () {
      const [ana, bia, cris] = yield* Effect.all([member("Ana"), member("Bia"), member("Cris")]);
      const rooms = yield* Rooms;
      const launch = yield* rooms.create({
        commandId: command(),
        name: "Launch",
        members: [ana.bot.id, bia.bot.id],
      });
      const ops = yield* rooms.create({
        commandId: command(),
        name: "Ops",
        members: [bia.bot.id, cris.bot.id],
      });
      const toAna: EntryTarget = { _tag: "conversation", botId: ana.bot.id };

      const id = yield* write(toAna, "@Bia ask @Launch", [bot(bia.bot.id), room(launch.id)]);
      const sent = (yield* conversation(ana.bot.id)).find((entry) => entry.id === id);
      assert.deepStrictEqual(sent?._tag === "message" ? sent.conversationMentions : undefined, [
        bot(bia.bot.id),
        room(launch.id),
      ]);

      const before = (yield* conversation(ana.bot.id)).length;
      const refused = (named: ReadonlyArray<ConversationMention>, mentions?: Mentions) =>
        Effect.flip(write(toAna, "hi", named, mentions));
      yield* archive(launch.id, true);
      const outcomes = yield* Effect.all([
        // A room the bot is not a member of.
        refused([room(ops.id)]),
        // The bot itself.
        refused([bot(ana.bot.id)]),
        // Ids nobody has.
        refused([bot(BotId.make("nobody"))]),
        refused([room(RoomId.make("nowhere"))]),
        // The same bot twice.
        refused([bot(bia.bot.id), bot(bia.bot.id)]),
        // A room the bot is in, archived.
        refused([room(launch.id)]),
        // `everyone` has no meaning in a conversation.
        refused([], { _tag: "everyone" }),
      ]);
      for (const error of outcomes)
        assert.deepStrictEqual(error, new Invalid({ reason: "mentions" }));
      assert.strictEqual((yield* conversation(ana.bot.id)).length, before);

      // A room message keeps its own rules: a conversation mention there is refused.
      yield* archive(launch.id, false);
      const inRoom = yield* Effect.flip(
        write({ _tag: "room", roomId: launch.id }, "hi", [bot(cris.bot.id)]),
      );
      assert.deepStrictEqual(inRoom, new Invalid({ reason: "mentions" }));
      assert.lengthOf(yield* roomEntries(launch.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the bot each mention resolved beside the message, and wakes nobody it mentions",
  () =>
    Effect.gen(function* () {
      const [ana, bia, cris] = yield* Effect.all([member("Ana"), member("Bia"), member("Cris")]);
      const launch = yield* (yield* Rooms).create({
        commandId: command(),
        name: "Launch",
        members: [ana.bot.id, bia.bot.id, cris.bot.id],
      });
      const biaBefore = (yield* conversation(bia.bot.id)).length;

      yield* write({ _tag: "conversation", botId: ana.bot.id }, "@Bia hi! and tell @Launch", [
        bot(bia.bot.id),
        room(launch.id),
      ]);
      yield* flushed(ana.bot.id);
      yield* settle([bia, cris]);

      const [envelope] = (yield* received(ana.session)).map((dispatch) => dispatch.text);
      assert.include(envelope, "A mention reaches no one");
      assert.include(envelope, `<mention kind="bot" id="${bia.bot.id}" name="Bia"/>`);
      assert.include(
        envelope,
        `<mention kind="room" id="${launch.id}" name="Launch" member="true"/>`,
      );
      // Nothing reached Bia, Cris or the room.
      assert.lengthOf(yield* received(bia.session), 0);
      assert.lengthOf(yield* received(cris.session), 0);
      assert.strictEqual((yield* conversation(bia.bot.id)).length, biaBefore);
      assert.lengthOf(yield* roomEntries(launch.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);
