// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, Sequence } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { Entries, type EntryFrame } from "./Entries.ts";

const say = (botId: BotId, text: string, by: "bot" | "operator" = "bot") =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    return yield* entries.append({
      target: { _tag: "conversation", botId },
      entry: {
        _tag: "message",
        author: by === "bot" ? { _tag: "bot", botId } : { _tag: "operator" },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "delivered" },
        commandId: null,
      },
    });
  });

const textsOf = (frame: EntryFrame) =>
  (frame._tag === "snapshot" ? frame.entries : frame.upsert).map((entry) =>
    entry._tag === "message" ? entry.text : entry._tag,
  );

it.effect(
  "sends the latest entries, then each change after them, and resumes from a sequence",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const entries = yield* Entries;
      const bot = yield* bots.create({
        commandId: CommandId.make("create"),
        draft: { name: "Ana" },
      });
      const target = { _tag: "conversation", botId: bot.id } as const;
      yield* say(bot.id, "before");
      const frames = yield* Queue.unbounded<EntryFrame>();
      yield* entries.subscribe(target, null).pipe(
        Stream.runForEach((frame) => Queue.offer(frames, frame)),
        Effect.forkScoped,
      );

      const snapshot = yield* Queue.take(frames);
      yield* say(bot.id, "first");
      const first = yield* Queue.take(frames);
      yield* say(bot.id, "second");
      const second = yield* Queue.take(frames);

      assert.deepStrictEqual(
        [snapshot, first, second].map((frame) => frame._tag),
        ["snapshot", "changed", "changed"],
      );
      assert.deepStrictEqual([snapshot, first, second].map(textsOf), [
        ["before"],
        ["first"],
        ["second"],
      ]);
      const resumed = yield* entries
        .subscribe(target, first.sequence)
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(resumed.map(textsOf), [["second"]]);
      assert.strictEqual(resumed[0]?.sequence, second.sequence);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("sends a snapshot when asked to resume from a sequence it never gave", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const entries = yield* Entries;
    const bot = yield* bots.create({ commandId: CommandId.make("create"), draft: { name: "Ana" } });
    yield* say(bot.id, "hello");

    const [frame] = yield* entries
      .subscribe({ _tag: "conversation", botId: bot.id }, Sequence.make(1_000_000))
      .pipe(Stream.take(1), Stream.runCollect);

    assert.strictEqual(frame?._tag, "snapshot");
    assert.deepStrictEqual(frame === undefined ? [] : textsOf(frame), ["hello"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "marks a conversation unread from the bot's last entry, until it is read past it again",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const entries = yield* Entries;
      const unread = (botId: BotId) =>
        entries.summary({ _tag: "conversation", botId }).pipe(Effect.map((s) => s.unread));
      const ana = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });
      const bia = yield* bots.create({ commandId: CommandId.make("bia"), draft: { name: "Bia" } });
      const conversation = { _tag: "conversation", botId: ana.id } as const;
      yield* say(ana.id, "Here is the report.");
      const reply = yield* say(ana.id, "Thanks!", "operator");
      yield* entries.markRead(conversation, reply.order);
      const before = yield* unread(ana.id);

      yield* entries.markUnread({ commandId: CommandId.make("unread-1"), target: conversation });
      yield* entries.markUnread({ commandId: CommandId.make("unread-2"), target: conversation });
      const marked = yield* unread(ana.id);
      yield* entries.markRead(conversation, reply.order);
      const readAgain = yield* unread(ana.id);

      // Only the operator wrote here: there is nothing a bot said to read again.
      const own = yield* say(bia.id, "Hello?", "operator");
      yield* entries.markRead({ _tag: "conversation", botId: bia.id }, own.order);
      yield* entries.markUnread({
        commandId: CommandId.make("unread-3"),
        target: { _tag: "conversation", botId: bia.id },
      });

      assert.deepStrictEqual([before, marked, readAgain], [false, true, false]);
      assert.isFalse(yield* unread(bia.id));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("applies a mark as unread once: sent again after a later read, it leaves the read", () =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const entries = yield* Entries;
    const ana = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });
    const target = { _tag: "conversation", botId: ana.id } as const;
    const said = yield* say(ana.id, "Here is the report.");
    const unread = entries.summary(target).pipe(Effect.map((summary) => summary.unread));
    yield* entries.markRead(target, said.order);
    const command = { commandId: CommandId.make("unread"), target };

    yield* entries.markUnread(command);
    const marked = yield* unread;
    // Read on another device; then the first command arrives again, as a connection replays it.
    yield* entries.markRead(target, said.order);
    yield* entries.markUnread(command);

    assert.isTrue(marked);
    assert.isFalse(yield* unread);
  }).pipe(Effect.provide(TestDomain.layer)),
);
