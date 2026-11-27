// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  Conflict,
  type EntryId,
  type Notice,
  ROOM_CLOSING_ROUND,
  ReactionEmoji,
  ROOM_QUIET_ROUND,
  RoomId,
} from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import {
  ROOM_BOTS_ONLY_CLOSING_NOTE,
  ROOM_BOTS_ONLY_LINE,
  ROOM_CLOSING_NOTE,
  ROOM_PAUSED_LINE,
} from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Bots } from "../bots/Bots.ts";
import { Reactions } from "../reactions/Reactions.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  lastEnvelope,
  type Member,
  member,
  noticesIn,
  roomEntries,
  roomWakeStatuses,
  roundsIn,
  say,
  stopRoom,
} from "../testing/rooms.ts";
import { command, conversation, nextTurn, sendToBot } from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { Rooms } from "./Rooms.ts";

// A room of bots only (decision 0103, `docs/architecture/server.md`, Rooms):
// a bot starts it on the operator's word without them in it; they read it and
// never write, react or answer there, its rounds count from its kickoff, and
// at their limit it pauses and the bot that started it is told.

let calls = 0;

/** The member calls a `j3` tool in its running turn, which the engine records first. */
const call = (one: Member, turnId: TurnId, tool: string, args: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: one.session,
      turnId,
      tool,
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `bots-only-call-${++calls}`,
      sessionId: one.session,
      tool,
      arguments: args,
    });
  });

const resultOf = (response: ToolCallResponse) =>
  response._tag === "result"
    ? response.value
    : assert.fail(`expected a result, got ${JSON.stringify(response)}`);

const refusalOf = (response: ToolCallResponse) =>
  response._tag === "refused"
    ? response.message
    : assert.fail(`expected a refusal, got ${JSON.stringify(response)}`);

const thumbsUp = Schema.decodeSync(ReactionEmoji)("👍");
const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ id: RoomId }));
const decodeRecorded = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Literal("recorded"), note: Schema.String }),
);

const noticesOf = (botId: BotId) =>
  Effect.map(conversation(botId), (entries) =>
    entries.flatMap((entry): ReadonlyArray<Notice> =>
      entry._tag === "notice" ? [entry.notice] : [],
    ),
  );

/**
 * The operator asks `starter` for a room of bots only with `others`; its turn
 * starts it, with a kickoff that wakes every other member, and goes on
 * running.
 */
const startBotsOnly = (starter: Member, others: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    yield* sendToBot(starter.bot.id, "Have the team settle the launch plan among yourselves.");
    const turnId = yield* nextTurn(starter.bot.id);
    const started = yield* call(starter, turnId, "start_room", {
      name: "Launch plan",
      members: others.map((one) => one.bot.id),
      kickoff: "Settle the launch plan: Pip the date, then me the checklist.",
      with_user: false,
    });
    return { roomId: decodeStarted(resultOf(started)).id, turnId };
  });

it.effect("starts a room of bots only on the operator's word, hidden, its members told so", () =>
  Effect.gen(function* () {
    const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
    const { roomId, turnId } = yield* startBotsOnly(scout, [pip]);
    yield* finish(scout, turnId, [scout, pip]);

    const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
    assert.isTrue(room.botsOnly);
    // It lands among the hidden conversations, as the bot did not show it.
    assert.isTrue(room.hidden);
    yield* nextTurn(pip.bot.id);
    const envelope = yield* lastEnvelope(pip);
    assert.include(envelope, 'bots-only="true"');
    assert.include(envelope, ROOM_BOTS_ONLY_LINE);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts no room whose call leaves out whether the operator takes part", () =>
  Effect.gen(function* () {
    const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
    yield* sendToBot(scout.bot.id, "Start a room with Pip.");
    const turnId = yield* nextTurn(scout.bot.id);

    const started = yield* call(scout, turnId, "start_room", {
      name: "Launch plan",
      members: [pip.bot.id],
      kickoff: "Pip, the date.",
    });

    assert.include(refusalOf(started), "with_user");
    assert.deepStrictEqual(yield* (yield* Rooms).list, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "counts a room of bots only from its kickoff, and pauses it there, telling the bot that started it",
  () =>
    Effect.gen(function* () {
      const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
      const members = [scout, pip];
      const { roomId, turnId: started } = yield* startBotsOnly(scout, [pip]);
      yield* say(scout, started, { text: "Pip and I are on it.", done: true });
      yield* finish(scout, started, members);

      // Pip answers the kickoff, Scout answers Pip, and so on: round n is the
      // n-th answer, by Pip when n is odd.
      const turns: Record<string, TurnId | null> = { Pip: null, Scout: started };
      const answers: Array<ToolCallResponse> = [];
      const closing: Array<boolean> = [];
      for (let round = 1; round <= ROOM_QUIET_ROUND + 1; round++) {
        const one = round % 2 === 1 ? pip : scout;
        const turnId = yield* nextTurn(one.bot.id, turns[one.bot.profile.name] ?? null);
        turns[one.bot.profile.name] = turnId;
        const envelope = yield* lastEnvelope(one);
        assert.notInclude(envelope, ROOM_CLOSING_NOTE);
        closing.push(envelope.includes(ROOM_BOTS_ONLY_CLOSING_NOTE));
        answers.push(yield* say(one, turnId, { text: `Round ${round}.` }));
        yield* finish(one, turnId, members);
      }

      assert.deepStrictEqual(
        closing,
        Array.from({ length: ROOM_QUIET_ROUND + 1 }, (_, index) => index + 1 >= ROOM_CLOSING_ROUND),
      );
      assert.deepStrictEqual(
        (yield* roundsIn(roomId)).map(([, round]) => round),
        Array.from({ length: ROOM_QUIET_ROUND + 2 }, (_, round) => round),
      );
      const last = answers.at(-1);
      if (last === undefined) return yield* Effect.die("the room was answered");
      assert.include(decodeRecorded(resultOf(last)).note, "paused");
      // The room shows the pause, never the operator's limit; so does the
      // starter's own conversation, where it is woken to tell the operator.
      const paused = { _tag: "room-paused", botId: scout.bot.id, roomId } as const;
      assert.deepStrictEqual(yield* noticesIn(roomId), [
        { _tag: "room-started", botId: scout.bot.id, roomId },
        paused,
      ]);
      assert.deepStrictEqual((yield* noticesOf(scout.bot.id)).at(-1), paused);
      yield* nextTurn(scout.bot.id, turns["Scout"] ?? null);
      const told = yield* lastEnvelope(scout);
      assert.include(told, ROOM_PAUSED_LINE);
      assert.include(told, 'name="Launch plan"');
    }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * Pip and Wren answer each other in `roomId`, each naming the other, from Pip's
 * answer to the kickoff to round `last`: by default the first answer past the
 * limit, which pauses it. The last room turn each had.
 */
const talkTo = (roomId: RoomId, pip: Member, wren: Member, last = ROOM_QUIET_ROUND + 1) =>
  Effect.gen(function* () {
    const members = [pip, wren];
    const turns = new Map<BotId, TurnId>();
    for (let round = 1; round <= last; round++) {
      const [one, other] = round % 2 === 1 ? [pip, wren] : [wren, pip];
      const turnId = yield* nextTurn(one.bot.id, turns.get(one.bot.id) ?? null);
      turns.set(one.bot.id, turnId);
      yield* say(one, turnId, { text: `Round ${round}.`, mention: [other.bot.id] });
      yield* finish(one, turnId, members);
    }
    assert.strictEqual((yield* roundsIn(roomId)).at(-1)?.[1], last);
    return turns;
  });

/** The `room-paused` wakes the bot has, by status. */
const pausedWakes = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM wakes
      WHERE bot_id = ${botId} AND json_extract(payload_json, '$._tag') = 'room-paused'
    `.pipe(Effect.orDie);
    return rows.map((row) => row.status);
  });

/** Scout starts a room of bots only whose kickoff wakes Pip alone, and keeps its turn. */
const startForPip = (scout: Member, pip: Member, wren: Member) =>
  Effect.gen(function* () {
    yield* sendToBot(scout.bot.id, "Have Pip and Wren settle the launch plan between them.");
    const turnId = yield* nextTurn(scout.bot.id);
    const started = yield* call(scout, turnId, "start_room", {
      name: "Launch plan",
      members: [pip.bot.id, wren.bot.id],
      kickoff: "Pip the date, Wren the checklist.",
      mention: [pip.bot.id],
      with_user: false,
    });
    return { roomId: decodeStarted(resultOf(started)).id, turnId };
  });

it.effect("drops the starter's word of a pause once the operator stops the room", () =>
  Effect.gen(function* () {
    const [scout, pip, wren] = [
      yield* member("Scout"),
      yield* member("Pip"),
      yield* member("Wren"),
    ];
    // Scout's turn runs on while the others talk, so the pause's wake waits for it.
    const { roomId, turnId } = yield* startForPip(scout, pip, wren);
    yield* talkTo(roomId, pip, wren);
    assert.deepStrictEqual(yield* pausedWakes(scout.bot.id), ["pending"]);

    yield* stopRoom(roomId);

    assert.deepStrictEqual(yield* pausedWakes(scout.bot.id), ["cancelled"]);
    yield* say(scout, turnId, { text: "Pip and Wren are on it.", done: true });
    yield* finish(scout, turnId, [scout, pip, wren]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "drops it too when the post that paused the room came from a member's own conversation",
  () =>
    Effect.gen(function* () {
      const [scout, pip, wren] = [
        yield* member("Scout"),
        yield* member("Pip"),
        yield* member("Wren"),
      ];
      const { roomId, turnId } = yield* startForPip(scout, pip, wren);
      const turns = yield* talkTo(roomId, pip, wren, ROOM_QUIET_ROUND);
      // Pip reads Wren's last answer in a room turn and says nothing there; then,
      // in its own conversation, posts in the room, which pauses it.
      const read = yield* nextTurn(pip.bot.id, turns.get(pip.bot.id) ?? null);
      yield* finish(pip, read, [pip, wren]);
      yield* sendToBot(pip.bot.id, "Tell the room the venue is booked.");
      const own = yield* nextTurn(pip.bot.id, read);
      yield* call(pip, own, "message_bot", { to: roomId, text: "The venue is booked." });
      yield* say(pip, own, { text: "Told them.", done: true });
      yield* finish(pip, own, [pip, wren]);
      assert.deepStrictEqual(yield* pausedWakes(scout.bot.id), ["pending"]);

      yield* stopRoom(roomId);

      assert.deepStrictEqual(yield* pausedWakes(scout.bot.id), ["cancelled"]);
      yield* say(scout, turnId, { text: "Pip and Wren are on it.", done: true });
      yield* finish(scout, turnId, [scout, pip, wren]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows the pause of a room of bots only whose starter was deleted, telling nobody", () =>
  Effect.gen(function* () {
    const [scout, pip, wren] = [
      yield* member("Scout"),
      yield* member("Pip"),
      yield* member("Wren"),
    ];
    const { roomId, turnId } = yield* startForPip(scout, pip, wren);
    yield* say(scout, turnId, { text: "Pip and Wren are on it.", done: true });
    yield* finish(scout, turnId, [scout, pip, wren]);
    yield* (yield* Bots).remove({ commandId: command(), botId: scout.bot.id, deleteFiles: true });

    yield* talkTo(roomId, pip, wren);

    assert.deepStrictEqual((yield* noticesIn(roomId)).at(-1), {
      _tag: "room-paused",
      botId: null,
      roomId,
    });
    assert.deepStrictEqual(yield* pausedWakes(scout.bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes a bot's post from a turn the operator spoke in as its own, not their word", () =>
  Effect.gen(function* () {
    const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
    const { roomId, turnId } = yield* startBotsOnly(scout, [pip]);

    // In a room with the operator, this first post of a turn they spoke in
    // would be their word, round 0, and count the rounds again from it.
    yield* call(scout, turnId, "message_bot", { to: roomId, text: "Pip, mind the holidays." });

    assert.deepStrictEqual(yield* roundsIn(roomId), [
      ["Settle the launch plan: Pip the date, then me the checklist.", 0],
      ["Pip, mind the holidays.", 1],
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a question from a turn of a room of bots only, which nobody answers", () =>
  Effect.gen(function* () {
    const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
    const { roomId, turnId } = yield* startBotsOnly(scout, [pip]);
    yield* finish(scout, turnId, [scout, pip]);
    const kickoff = yield* nextTurn(pip.bot.id);

    const asked = yield* call(pip, kickoff, "ask", {
      prompt: "Which date?",
      options: [{ label: "Friday" }],
    });

    assert.include(refusalOf(asked), "does not take part in the room Launch plan");
    assert.isFalse((yield* conversation(pip.bot.id)).some((entry) => entry._tag === "question"));
    assert.deepStrictEqual(yield* noticesIn(roomId), [
      { _tag: "room-started", botId: scout.bot.id, roomId },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "takes nothing of the operator's in a room of bots only, and keeps their other actions",
  () =>
    Effect.gen(function* () {
      const [scout, pip] = [yield* member("Scout"), yield* member("Pip")];
      const { roomId, turnId } = yield* startBotsOnly(scout, [pip]);
      yield* finish(scout, turnId, [scout, pip]);
      const pipeline = yield* Pipeline;
      const rooms = yield* Rooms;
      const before = yield* roomEntries(roomId);
      const kickoff = before.find((entry) => entry._tag === "message");
      if (kickoff === undefined) return yield* Effect.die("the room has its kickoff");
      const send = (extra: {
        readonly mentions?: { readonly _tag: "everyone" };
        readonly quotes?: ReadonlyArray<{ readonly entryId: EntryId }>;
      }) =>
        Effect.flip(
          pipeline.sendMessage({
            commandId: command(),
            target: { _tag: "room", roomId },
            text: "Make it Friday.",
            attachments: [],
            ...extra,
          }),
        );
      const refused = new Conflict({ reason: "room-bots-only" });

      // Their message, a reply to the kickoff, `@everyone`, a reaction, a new
      // name or other members: each is refused, and nothing is written.
      assert.deepStrictEqual(yield* send({}), refused);
      assert.deepStrictEqual(yield* send({ quotes: [{ entryId: kickoff.id }] }), refused);
      assert.deepStrictEqual(yield* send({ mentions: { _tag: "everyone" } }), refused);
      assert.deepStrictEqual(
        yield* Effect.flip((yield* Reactions).react({ entryId: kickoff.id, emoji: thumbsUp })),
        refused,
      );
      const update = (changes: Parameters<typeof rooms.update>[0]["changes"]) =>
        rooms.update({ commandId: command(), roomId, changes });
      assert.deepStrictEqual(yield* Effect.flip(update({ name: "Mine" })), refused);
      assert.deepStrictEqual(
        yield* Effect.flip(update({ members: [scout.bot.id, pip.bot.id].toReversed() })),
        refused,
      );
      assert.deepStrictEqual(yield* roomEntries(roomId), before);

      // Mentioning it in a bot's conversation only points at it, as anywhere.
      yield* pipeline.sendMessage({
        commandId: command(),
        target: { _tag: "conversation", botId: scout.bot.id },
        text: "How is it going in there?",
        attachments: [],
        conversationMentions: [{ _tag: "room", roomId }],
      });
      assert.deepStrictEqual(yield* roomEntries(roomId), before);
      assert.deepStrictEqual(yield* roomWakeStatuses(scout.bot.id, roomId), []);

      // Where it sits in their list, and whether it lasts, stay theirs.
      const kept = yield* update({ pinned: true, hidden: true, archived: true });
      assert.deepStrictEqual([kept.pinned, kept.hidden, kept.status], [true, true, "archived"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);
