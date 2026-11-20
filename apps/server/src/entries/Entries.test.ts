// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, Sequence } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { Entries, type EntryFrame } from "./Entries.ts";

const say = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    return yield* entries.append({
      target: { _tag: "conversation", botId },
      entry: {
        _tag: "message",
        author: { _tag: "bot", botId },
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
