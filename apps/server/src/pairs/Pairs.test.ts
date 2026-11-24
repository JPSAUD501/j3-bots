// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, type PairBotIds, pairBotIds, type TeammatePair } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, conversation, createBot, heldForTeammates } from "../testing/turns.ts";
import { type PairMessagesFrame, Pairs, type PairsFrame } from "./Pairs.ts";

const remove = (botId: BotId) =>
  Effect.gen(function* () {
    yield* (yield* Bots).remove({ commandId: command(), botId, deleteFiles: true });
  });

const keyOf = (botIds: PairBotIds) => botIds.join(" ");

/** A pair's whole conversation, oldest first. */
const historyOf = (botIds: PairBotIds) =>
  Effect.gen(function* () {
    return (yield* (yield* Pairs).history({ botIds, before: null, limit: 200 })).messages;
  });

/** Every frame of `stream` as it comes, read in the test's scope. */
const follow = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<A>();
    yield* stream.pipe(
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return frames;
  });

/** The next frame for which `check` holds, skipping the others. */
const frameWhere = <A>(frames: Queue.Queue<A>, check: (frame: A) => boolean) =>
  Effect.gen(function* () {
    for (;;) {
      const frame = yield* Queue.take(frames);
      if (check(frame)) return frame;
    }
  });

const upserted = (frame: PairsFrame, botIds: PairBotIds): TeammatePair | undefined =>
  frame._tag === "changed"
    ? frame.upsert.find((pair) => keyOf(pair.botIds) === keyOf(botIds))
    : undefined;

it.effect("lists each pair once, latest message first, and its messages in the order sent", () =>
  Effect.gen(function* () {
    const pairs = yield* Pairs;
    const ana = yield* createBot("Ana");
    const bo = yield* createBot("Bo");
    const cy = yield* createBot("Cy");
    yield* heldForTeammates(ana.id, [
      { to: bo.id, text: "Draft the launch post." },
      { to: cy.id, text: "Check the prices." },
      { to: bo.id, text: "Keep it short." },
    ]);
    yield* heldForTeammates(bo.id, [{ to: ana.id, text: "Posted." }]);
    const anaBo = pairBotIds(ana.id, bo.id);

    const [snapshot] = yield* pairs.subscribe.pipe(Stream.take(1), Stream.runCollect);
    assert.deepStrictEqual(
      snapshot?._tag === "snapshot"
        ? snapshot.pairs.map((pair) => [keyOf(pair.botIds), pair.count, pair.lastMessage.text])
        : [],
      [
        [keyOf(anaBo), 3, "Posted."],
        [keyOf(pairBotIds(ana.id, cy.id)), 1, "Check the prices."],
      ],
    );

    const messages = yield* historyOf(anaBo);
    assert.deepStrictEqual(
      messages.map((message) => [message.from, message.to, message.text]),
      [
        [ana.id, bo.id, "Draft the launch post."],
        [ana.id, bo.id, "Keep it short."],
        [bo.id, ana.id, "Posted."],
      ],
    );
    // Each message names the cards a client holds in the two conversations.
    const cards = (yield* conversation(bo.id)).flatMap((entry) =>
      entry._tag === "handoff" ? [[entry.id, entry.direction, entry.text]] : [],
    );
    assert.deepStrictEqual(
      cards,
      messages.map((message) =>
        message.to === bo.id
          ? [message.receivedEntryId, "received", message.text]
          : [message.sentEntryId, "sent", message.text],
      ),
    );

    const last = messages.at(-1);
    const page = yield* pairs.history({ botIds: anaBo, before: last?.seq ?? null, limit: 1 });
    assert.deepStrictEqual(
      [page.messages.map((message) => message.text), page.hasOlder],
      [["Keep it short."], true],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps a pair readable from the other bot's cards once one is deleted, and drops it with both",
  () =>
    Effect.gen(function* () {
      const pairs = yield* Pairs;
      const ana = yield* createBot("Ana");
      const bo = yield* createBot("Bo");
      yield* heldForTeammates(ana.id, [{ to: bo.id, text: "Draft the launch post." }]);
      yield* heldForTeammates(bo.id, [{ to: ana.id, text: "On it." }]);
      const anaBo = pairBotIds(ana.id, bo.id);
      const frames = yield* follow(pairs.subscribe);
      yield* Queue.take(frames);

      yield* remove(bo.id);
      const changed = yield* frameWhere(
        frames,
        (frame) => upserted(frame, anaBo)?.lastMessage.sentEntryId === null,
      );
      assert.strictEqual(upserted(changed, anaBo)?.count, 2);
      // Bo read Ana's message in the turn it answered from: her card says so.
      assert.deepStrictEqual(
        (yield* historyOf(anaBo)).map((message) => [
          message.text,
          message.state,
          message.sentEntryId === null,
          message.receivedEntryId === null,
        ]),
        [
          ["Draft the launch post.", "sent", false, true],
          ["On it.", "sent", true, false],
        ],
      );

      yield* remove(ana.id);
      const gone = yield* frameWhere(frames, (frame) => frame._tag === "changed");
      assert.deepStrictEqual(gone, { _tag: "changed", upsert: [], remove: [anaBo] });
      assert.deepStrictEqual(yield* historyOf(anaBo), []);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("follows an open pair: each new message, and a fresh start once a bot is deleted", () =>
  Effect.gen(function* () {
    const pairs = yield* Pairs;
    const ana = yield* createBot("Ana");
    const bo = yield* createBot("Bo");
    const cy = yield* createBot("Cy");
    yield* heldForTeammates(ana.id, [{ to: bo.id, text: "Draft the launch post." }]);
    const anaBo = pairBotIds(ana.id, bo.id);
    const texts = (frame: PairMessagesFrame) =>
      (frame._tag === "snapshot" ? frame.messages : frame.upsert).map((message) => message.text);
    const frames = yield* follow(pairs.messages(anaBo));
    const snapshot = yield* Queue.take(frames);
    assert.deepStrictEqual(
      [snapshot._tag, texts(snapshot)],
      ["snapshot", ["Draft the launch post."]],
    );

    // Another pair's message changes nothing here.
    yield* heldForTeammates(ana.id, [
      { to: cy.id, text: "Check the prices." },
      { to: bo.id, text: "Keep it short." },
    ]);
    const added = yield* Queue.take(frames);
    assert.deepStrictEqual([added._tag, texts(added)], ["changed", ["Keep it short."]]);

    // Bo never had a turn to read them in: they will not reach it now.
    yield* remove(bo.id);
    const restarted = yield* frameWhere(frames, (frame) => frame._tag === "snapshot");
    assert.deepStrictEqual(
      restarted._tag === "snapshot"
        ? restarted.messages.map((message) => [message.text, message.state])
        : [],
      [
        ["Draft the launch post.", "not-delivered"],
        ["Keep it short.", "not-delivered"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
