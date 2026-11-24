// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type Attachment,
  type BotId,
  MAX_MESSAGE_LENGTH,
  type Mentions,
  ROOM_CLOSING_AFTER,
  ROOM_QUIET_AFTER,
  type RoomId,
} from "@j3-bots/contracts";
import { ENGINE_INPUT_LIMIT, type TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { ROOM_CLOSING_NOTE } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Attachments } from "../attachments/Attachments.ts";
import { Bots } from "../bots/Bots.ts";
import { Entries } from "../entries/Entries.ts";
import { Layout } from "../Layout.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  lastEnvelope,
  liveRoomWork,
  type Member,
  member,
  nobody,
  noticesIn,
  operatorWrites,
  roomEntries,
  roomWakeStatuses,
  roomWakesOf,
  roomWith,
  running,
  sawText,
  say,
  settle,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  command,
  concurrentTurns,
  conversation,
  createBot,
  deliveryIs,
  gateSettled,
  holdGate,
  nextTurn,
  providerIs,
  received,
  recoverTimes,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { inboxPath } from "../turns/inbox.ts";
import { MAX_INDETERMINATE_ANSWERS, recoveryBackoff } from "../turns/model.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { Stops } from "../turns/Stops.ts";
import { Rooms } from "./Rooms.ts";

/** What the tool answers a room message the quiet room posted without waking anyone. */
const RoomQuiet = Schema.Struct({ stopped: Schema.Literal("room") });

/** Whether the room was quiet: the message is posted, and the tool says it woke nobody. */
const wokeNobody = (response: ToolCallResponse) =>
  response._tag === "result" && Schema.is(RoomQuiet)(response.value);

/** The room's messages, oldest first: their text. */
const roomTexts = (roomId: RoomId) =>
  Effect.map(roomEntries(roomId), (entries) =>
    entries.flatMap((entry) => (entry._tag === "message" ? [entry.text] : [])),
  );

it.effect(
  "hands a room's work on by mention, one turn at a time, waking only the member mentioned while the others read it in their next envelope",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo, cy] = [
        yield* member("Hal"),
        yield* member("Ana"),
        yield* member("Bo"),
        yield* member("Cy"),
      ];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      // The operator addresses Hal, who alone is woken.
      const asked = yield* operatorWrites(room.id, members, "Write the launch note.", to(hal));
      const halFirst = yield* nextTurn(hal.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      assert.include(yield* lastEnvelope(hal), 'reason="addressed"');
      yield* say(hal, halFirst, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
      yield* finish(hal, halFirst, members);
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), 0);

      // Ana reads the operator's message with Hal's, which woke her.
      const anaFirst = yield* nextTurn(ana.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      const anaEnvelope = yield* lastEnvelope(ana);
      assert.include(anaEnvelope, "Write the launch note.");
      assert.include(anaEnvelope, "Ana, find the numbers.");
      assert.include(anaEnvelope, 'reason="addressed"');
      yield* say(ana, anaFirst, {
        text: "Revenue grew 12%. Bo, write it up.",
        mention: [bo.bot.id],
      });
      yield* finish(ana, anaFirst, members);

      // Bo, woken only now, reads everything said before it.
      const boFirst = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      const boEnvelope = yield* lastEnvelope(bo);
      assert.include(boEnvelope, "Write the launch note.");
      assert.include(boEnvelope, "Ana, find the numbers.");
      assert.include(boEnvelope, "Revenue grew 12%.");
      assert.include(boEnvelope, 'reason="addressed"');
      yield* say(bo, boFirst, { text: "Draft in files/note.md. Hal?", mention: [hal.bot.id] });
      yield* finish(bo, boFirst, members);

      const halLast = yield* nextTurn(hal.bot.id, halFirst);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      // Only what Hal has not seen: what Ana and Bo said since its turn.
      const halEnvelope = yield* lastEnvelope(hal);
      assert.notInclude(halEnvelope, "Write the launch note.");
      assert.include(halEnvelope, "Revenue grew 12%.");
      assert.include(halEnvelope, "Draft in files/note.md.");
      assert.include(halEnvelope, 'reason="addressed"');
      yield* say(hal, halLast, { text: "Done: the note is ready.", done: true });
      yield* finish(hal, halLast, members);

      // Hal's last word mentions nobody, so it wakes the others, who have
      // nothing to add.
      for (const [one, previous] of [
        [ana, anaFirst],
        [bo, boFirst],
      ] as const) {
        const turnId = yield* nextTurn(one.bot.id, previous);
        assert.deepStrictEqual(yield* running(members), [one.bot.profile.name]);
        const envelope = yield* lastEnvelope(one);
        assert.include(envelope, "Done: the note is ready.");
        assert.include(envelope, 'reason="member"');
        yield* finish(one, turnId, members);
      }

      // Silence wakes nobody: the room is quiet.
      assert.deepStrictEqual(yield* running(members), []);
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
      const sql = yield* SqlClient.SqlClient;
      const turns = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM turns WHERE audience_room_id = ${room.id}
      `.pipe(Effect.orDie);
      assert.strictEqual(turns[0]?.n, 6);
      assert.deepStrictEqual(yield* received(cy.session), []);
      yield* deliveryIs(asked, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "wakes every other member for a message that mentions nobody, in member order, each seeing the replies before it, and goes quiet once the rest stay silent",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo, cy] = [
        yield* member("Hal"),
        yield* member("Ana"),
        yield* member("Bo"),
        yield* member("Cy"),
      ];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      const asked = yield* operatorWrites(room.id, members, "Who has the revenue numbers?", nobody);
      // Hal reads it first and leaves it to the others.
      const halFirst = yield* nextTurn(hal.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      const halEnvelope = yield* lastEnvelope(hal);
      assert.include(halEnvelope, 'reason="user"');
      assert.include(halEnvelope, "Who has the revenue numbers?");
      yield* finish(hal, halFirst, members);

      // Ana's part: she answers.
      const anaTurn = yield* nextTurn(ana.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      assert.include(yield* lastEnvelope(ana), 'reason="user"');
      yield* say(ana, anaTurn, { text: "I do: revenue grew 12%." });
      yield* finish(ana, anaTurn, members);

      // Bo reads Ana's reply with the question, and has nothing to add. The
      // operator's message asks more of it than Ana's, so its reason is theirs.
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      const boEnvelope = yield* lastEnvelope(bo);
      assert.include(boEnvelope, 'reason="user"');
      assert.include(boEnvelope, "Who has the revenue numbers?");
      assert.include(boEnvelope, "I do: revenue grew 12%.");
      yield* finish(bo, boTurn, members);

      // Ana's reply reaches Hal too, as a member's word, and Hal stays silent.
      const halLast = yield* nextTurn(hal.bot.id, halFirst);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      const halReply = yield* lastEnvelope(hal);
      assert.include(halReply, 'reason="member"');
      assert.include(halReply, "I do: revenue grew 12%.");
      assert.notInclude(halReply, "Who has the revenue numbers?");
      yield* finish(hal, halLast, members);

      // Nothing more: silence wakes nobody.
      assert.deepStrictEqual(yield* running(members), []);
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
      assert.strictEqual(yield* roomWakesOf(hal.bot.id, room.id), 2);
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), 2);
      assert.deepStrictEqual(yield* received(cy.session), []);
      yield* deliveryIs(asked, "delivered");
      assert.deepStrictEqual(yield* roomTexts(room.id), [
        "Who has the revenue numbers?",
        "I do: revenue grew 12%.",
      ]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "wakes only the members the operator's message mentions, and every member for one to everyone, in member order",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      yield* operatorWrites(room.id, members, "Bo, then Ana: one line each.", to(bo, ana));
      for (const one of [ana, bo]) {
        const turnId = yield* nextTurn(one.bot.id);
        assert.deepStrictEqual(yield* running(members), [one.bot.profile.name]);
        const envelope = yield* lastEnvelope(one);
        assert.include(envelope, "Bo, then Ana: one line each.");
        assert.include(envelope, 'reason="addressed"');
        yield* finish(one, turnId, members);
      }
      // Hal was not mentioned, so it was not woken.
      assert.strictEqual(yield* roomWakesOf(hal.bot.id, room.id), 0);
      assert.deepStrictEqual(yield* received(hal.session), []);

      yield* operatorWrites(room.id, members, "Everyone: your status?", { _tag: "everyone" });
      for (const one of members) {
        const turnId = yield* nextTurn(one.bot.id);
        assert.deepStrictEqual(yield* running(members), [one.bot.profile.name]);
        const envelope = yield* lastEnvelope(one);
        assert.include(envelope, "Everyone: your status?");
        assert.include(envelope, 'reason="everyone"');
        yield* finish(one, turnId, members);
      }
      // Hal reads the message it was not woken for with the one that woke it.
      assert.include(yield* lastEnvelope(hal), "Bo, then Ana: one line each.");
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "says in every room envelope that the conversation is closing once the bots said enough since the operator wrote, until the operator writes again",
  () =>
    Effect.gen(function* () {
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);
      yield* operatorWrites(room.id, members, "Ana, settle the date with Bo.", to(ana));

      // One message short of closing: Ana's, then Bo's turn reads them.
      const anaFirst = yield* nextTurn(ana.bot.id);
      assert.notInclude(yield* lastEnvelope(ana), ROOM_CLOSING_NOTE);
      for (let n = 1; n < ROOM_CLOSING_AFTER; n++) {
        yield* say(ana, anaFirst, { text: `Bo, option ${n}?`, mention: [bo.bot.id] });
      }
      yield* finish(ana, anaFirst, members);
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.notInclude(yield* lastEnvelope(bo), ROOM_CLOSING_NOTE);

      // Bo's answer is the bots' sixth message: the conversation is closing.
      yield* say(bo, boTurn, { text: "Ana, option 3.", mention: [ana.bot.id] });
      yield* finish(bo, boTurn, members);
      const anaLast = yield* nextTurn(ana.bot.id, anaFirst);
      const closing = yield* lastEnvelope(ana);
      assert.include(closing, "Ana, option 3.");
      assert.include(closing, ROOM_CLOSING_NOTE);
      yield* finish(ana, anaLast, members);

      // The operator's word opens it again.
      yield* operatorWrites(room.id, members, "Bo, book it.", to(bo));
      yield* nextTurn(bo.bot.id, boTurn);
      const reopened = yield* lastEnvelope(bo);
      assert.include(reopened, "Bo, book it.");
      assert.notInclude(reopened, ROOM_CLOSING_NOTE);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "posts the bots' messages past the room's quiet limit without waking anyone, with one notice for the run, until the operator writes again",
  () =>
    Effect.gen(function* () {
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);
      yield* operatorWrites(room.id, members, "Ana, settle the date with Bo.", to(ana));

      // Ana says as much as the room takes, then two messages more.
      const anaFirst = yield* nextTurn(ana.bot.id);
      for (let n = 1; n <= ROOM_QUIET_AFTER; n++) {
        const said = yield* say(ana, anaFirst, { text: `Bo, option ${n}?`, mention: [bo.bot.id] });
        assert.strictEqual(said._tag, "result");
        assert.isFalse(wokeNobody(said));
      }
      for (const text of ["Bo, one more?", "Bo, the last?"]) {
        assert.isTrue(wokeNobody(yield* say(ana, anaFirst, { text, mention: [bo.bot.id] })));
      }
      yield* finish(ana, anaFirst, members);

      // Bo reads them all, the two that woke nobody included; its own answer
      // wakes nobody either.
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.include(yield* lastEnvelope(bo), "Bo, the last?");
      const answer = yield* say(bo, boTurn, { text: "Ana, option 3.", mention: [ana.bot.id] });
      assert.isTrue(wokeNobody(answer));
      yield* finish(bo, boTurn, members);

      assert.deepStrictEqual(yield* running(members), []);
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), ROOM_QUIET_AFTER);
      assert.includeMembers(yield* roomTexts(room.id), [
        "Bo, one more?",
        "Bo, the last?",
        "Ana, option 3.",
      ]);
      const stopped = { _tag: "chain-stopped", limit: "room" } as const;
      assert.deepStrictEqual(yield* noticesIn(room.id), [stopped]);

      // The operator writes: the bots' messages wake again, and a run past
      // the limit shows a notice of its own.
      yield* operatorWrites(room.id, members, "Pick one, both of you.", nobody);
      const anaLast = yield* nextTurn(ana.bot.id, anaFirst);
      const again = yield* say(ana, anaLast, { text: "Bo, option 3 it is.", mention: [bo.bot.id] });
      assert.isFalse(wokeNobody(again));
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), ROOM_QUIET_AFTER + 2);
      for (let n = 2; n <= ROOM_QUIET_AFTER; n++) {
        yield* say(ana, anaLast, { text: `Bo, still option 3 (${n}).`, mention: [bo.bot.id] });
      }
      const past = yield* say(ana, anaLast, { text: "Bo, really.", mention: [bo.bot.id] });
      assert.isTrue(wokeNobody(past));
      assert.deepStrictEqual(yield* noticesIn(room.id), [stopped, stopped]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** How many messages the room's bots have said since the operator last wrote there. */
const botStreak = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly bot_streak: number }>`
      SELECT bot_streak FROM rooms WHERE id = ${roomId}
    `.pipe(Effect.orDie);
    return row?.bot_streak ?? 0;
  });

it.effect(
  "counts what a member says in a room turn through the engine rather than `say`, and wakes every other member for it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [ana, bo, cy] = [yield* member("Ana"), yield* member("Bo"), yield* member("Cy")];
      const members = [ana, bo, cy];
      const room = yield* roomWith(ana, [bo, cy]);
      yield* operatorWrites(room.id, members, "Ana, how is the launch?", to(ana));

      const turn = yield* nextTurn(ana.bot.id);
      yield* control.hostSpeech({ sessionId: ana.session, turnId: turn, text: "On track." });
      yield* finish(ana, turn, members);

      assert.includeMembers(yield* roomTexts(room.id), ["On track."]);
      assert.strictEqual(yield* botStreak(room.id), 1);
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), 1);
      assert.strictEqual(yield* roomWakesOf(cy.bot.id, room.id), 1);
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "wakes nobody for what a turn the engine started for stopped room work says through the engine",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);
      yield* operatorWrites(room.id, members, "Bo, run the build.", to(bo));
      const building = yield* nextTurn(bo.bot.id);
      yield* control.startBackgroundWork({ sessionId: bo.session, turnId: building });
      yield* finish(bo, building, members);

      // The operator stops the room's work; the build wakes Bo's session
      // before that reaches it, with a turn that goes on with that work.
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      const done = yield* control.startEngineTurn(bo.session, building);
      yield* nextTurn(bo.bot.id, building);
      yield* control.hostSpeech({ sessionId: bo.session, turnId: done, text: "Ana, it passed." });
      yield* finish(bo, done, members);

      assert.includeMembers(yield* roomTexts(room.id), ["Ana, it passed."]);
      assert.strictEqual(yield* botStreak(room.id), 1);
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts a room message of work the operator stopped, which wakes nobody", () =>
  Effect.gen(function* () {
    const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
    const members = [ana, bo];
    const room = yield* roomWith(ana, [bo]);
    yield* operatorWrites(room.id, members, "Ana, ask Bo for the date.", to(ana));
    const turn = yield* nextTurn(ana.bot.id);

    // The Stop is recorded while Ana's `say` is still on its way.
    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* say(ana, turn, { text: "Bo, the date?", mention: [bo.bot.id] });

    assert.includeMembers(yield* roomTexts(room.id), ["Bo, the date?"]);
    assert.strictEqual(yield* botStreak(room.id), 1);
    assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("coalesces a room's waiting wakes into one envelope, never with another room's", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
    const room = yield* roomWith(hal, [ana]);
    const other = yield* roomWith(bo, [ana]);
    const all = [hal, ana, bo];

    // Ana is busy with a private turn while three room messages arrive for her.
    yield* sendToBot(ana.bot.id, "Check the build.");
    const privateTurn = yield* nextTurn(ana.bot.id);
    yield* operatorWrites(room.id, all, "First launch question.", to(ana));
    yield* operatorWrites(other.id, all, "An ops question.", to(ana));
    yield* operatorWrites(room.id, all, "Second launch question.", to(ana));
    const before = (yield* received(ana.session)).length;
    yield* control.finishTurn({
      sessionId: ana.session,
      turnId: privateTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(ana.bot.id);
    yield* settle(all);

    const launchTurn = yield* nextTurn(ana.bot.id);
    const launch = yield* lastEnvelope(ana);
    assert.strictEqual((yield* received(ana.session)).length, before + 1);
    assert.include(launch, "First launch question.");
    assert.include(launch, "Second launch question.");
    assert.notInclude(launch, "An ops question.");
    yield* finish(ana, launchTurn, all);

    yield* nextTurn(ana.bot.id, launchTurn);
    const ops = yield* lastEnvelope(ana);
    assert.include(ops, "An ops question.");
    assert.notInclude(ops, "launch question");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("steers the operator's room message into the bot's running turn for that room", () =>
  Effect.gen(function* () {
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Draft the agenda.", to(hal));
    const turnId = yield* nextTurn(hal.bot.id);
    yield* operatorWrites(room.id, members, "Keep it short.", to(hal));

    const [first, steer] = yield* received(hal.session);
    assert.strictEqual(first?.delivery._tag, "start");
    assert.strictEqual(steer?.delivery._tag, "steer");
    assert.include(steer?.text ?? "", "Keep it short.");
    assert.deepStrictEqual(yield* admittedTurn(hal.bot.id), Option.some(turnId));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a mention of itself, of a non-member or outside a room turn, writing nothing",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const outsider = yield* createBot("Cy");
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const turnId = yield* nextTurn(hal.bot.id);
      const entriesBefore = (yield* roomEntries(room.id)).length;

      const refusals = [
        { mention: [hal.bot.id], says: "your own" },
        { mention: [outsider.id], says: "not a member" },
      ];
      for (const { mention, says } of refusals) {
        const response = yield* say(hal, turnId, { text: "Over to you.", mention });
        assert.strictEqual(response._tag, "refused");
        assert.include(JSON.stringify(response), says);
      }
      const dm = yield* say(hal, turnId, { text: "Psst.", to: "dm", mention: [ana.bot.id] });
      assert.strictEqual(dm._tag, "refused");

      assert.strictEqual((yield* roomEntries(room.id)).length, entriesBefore);
      for (const member of [ana, bo]) {
        assert.strictEqual(yield* roomWakesOf(member.bot.id, room.id), 0);
      }
      const sql = yield* SqlClient.SqlClient;
      const pinned = yield* sql`SELECT 1 FROM tool_calls WHERE tool = 'say'`.pipe(Effect.orDie);
      assert.strictEqual(pinned.length, 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a mention in a turn that speaks to the operator", () =>
  Effect.gen(function* () {
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    yield* roomWith(hal, [ana]);
    yield* sendToBot(hal.bot.id, "Ask Ana for the numbers.");
    const turnId = yield* nextTurn(hal.bot.id);
    const response = yield* say(hal, turnId, { text: "Asking.", mention: [ana.bot.id] });
    assert.strictEqual(response._tag, "refused");
    assert.include(JSON.stringify(response), "only in a room turn");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps the entry that woke a member, adds the newest it has not seen that fit, and counts the rest",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      // Ana is busy elsewhere when the operator asks her, and the room then
      // fills with more than one envelope can carry.
      yield* sendToBot(ana.bot.id, "Check the build.");
      const privateTurn = yield* nextTurn(ana.bot.id);
      const question = "Ana, what did Hal decide?";
      const asked = yield* operatorWrites(room.id, members, question, to(ana));
      const entries = yield* Entries;
      const said = 40;
      for (let n = 1; n <= said; n++) {
        yield* entries.append({
          target: { _tag: "room", roomId: room.id },
          entry: {
            _tag: "message",
            author: { _tag: "bot", botId: hal.bot.id },
            text: `Note ${n}: ${"x".repeat(3_900)}`,
            attachments: [],
            mentions: nobody,
            delivery: { _tag: "delivered" },
            commandId: null,
          },
        });
      }
      yield* control.finishTurn({
        sessionId: ana.session,
        turnId: privateTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(ana.bot.id);
      yield* settle(members);

      yield* nextTurn(ana.bot.id, privateTurn);
      const envelope = yield* lastEnvelope(ana);
      assert.isAtMost(envelope.length, ENGINE_INPUT_LIMIT);
      assert.include(envelope, `Note ${said}:`);
      assert.notInclude(envelope, "Note 1:");
      // The question comes first, where it is in the room.
      assert.isAbove(envelope.indexOf("Note "), envelope.indexOf(question));
      const omitted = /(\d+) earlier entries you have not seen are left out/.exec(envelope);
      assert.isNotNull(omitted);
      const shown = envelope.split("Note ").length - 1;
      assert.strictEqual(Number(omitted?.[1]), said - shown);
      yield* deliveryIs(asked, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the room once per turn that a bot waits on the operator in its own conversation",
  () =>
    Effect.gen(function* () {
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Deploy the site.", to(hal));
      const turnId = yield* nextTurn(hal.bot.id);
      for (const action of ["deploy --prod", "deploy --staging"]) {
        yield* (yield* TestEngineControl).openRequest({
          sessionId: hal.session,
          turnId,
          request: {
            _tag: "approval",
            kind: "command",
            action,
            detail: null,
            reason: null,
            exact: true,
            sessionGrant: null,
          },
        });
      }
      // The cards are in Hal's own conversation; the room says once that Hal
      // waits there.
      yield* until(
        Effect.map(
          conversation(hal.bot.id),
          (entries) => entries.filter((entry) => entry._tag === "approval").length === 2,
        ),
      );
      const notices = yield* noticesIn(room.id);
      assert.deepStrictEqual(notices, [{ _tag: "waiting-in-conversation", botId: hal.bot.id }]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** The member's room turn fails at the usage limit, with a continuation pending for hours. */
const limitedAt = (one: Member, turnId: TurnId, members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    const at = DateTime.addDuration(yield* DateTime.now, Duration.hours(5));
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: one.session,
      turnId,
      outcome: { _tag: "failed", failure: "usage-limit", retryAt: at },
      continuation: { resumesAt: at },
    });
    yield* turnEnded(one.bot.id);
    yield* settle(members);
  });

it.effect(
  "runs other members while one's room turn waits for a usage limit's reset, and still takes the operator's word to it",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Ana, translate the docs.", to(ana));
      const limited = yield* nextTurn(ana.bot.id);
      yield* limitedAt(ana, limited, members);

      // Ana's turn waits hours for the reset; Bo answers meanwhile.
      yield* operatorWrites(room.id, members, "Bo, check the links.", to(bo));
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      yield* finish(bo, boTurn, members);

      // The operator's word to Ana goes now, as it does in private.
      const skip = yield* operatorWrites(room.id, members, "Ana, skip the appendix.", to(ana));
      yield* nextTurn(ana.bot.id, limited);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      assert.include(yield* lastEnvelope(ana), "Ana, skip the appendix.");
      yield* deliveryIs(skip, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "steers the room turn with the operator's word for the room while their private message waits",
  () =>
    Effect.gen(function* () {
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Draft the agenda.", to(hal));
      yield* nextTurn(hal.bot.id);
      // Older, and for Hal's conversation: it waits for the room turn to end.
      const flight = yield* sendToBot(hal.bot.id, "Book my flight.");
      yield* operatorWrites(room.id, members, "Keep it short.", to(hal));

      const sent = yield* received(hal.session);
      assert.deepStrictEqual(
        sent.map((dispatch) => dispatch.delivery._tag),
        ["start", "steer"],
      );
      assert.include(sent[1]?.text ?? "", "Keep it short.");
      assert.isFalse(yield* sawText(hal, "Book my flight."));
      yield* deliveryIs(flight, "pending");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives a member that left the room none of its waiting wakes, also one a removal left behind",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo, cy] = [
        yield* member("Hal"),
        yield* member("Ana"),
        yield* member("Bo"),
        yield* member("Cy"),
      ];
      const members = [hal, ana, bo, cy];
      const room = yield* roomWith(hal, [ana, bo, cy]);
      yield* operatorWrites(room.id, members, "Plan the offsite.", to(hal));
      const first = yield* nextTurn(hal.bot.id);

      // Ana's wake waits for Hal's turn, and Ana leaves the room meanwhile.
      const forAna = yield* operatorWrites(room.id, members, "Ana, the budget is secret.", to(ana));
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id, cy.bot.id] },
      });
      assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["cancelled"]);
      yield* deliveryIs(forAna, "cancelled");

      // A wake that outlived its bot's membership is cancelled when planned,
      // and holds the room no more.
      const forBo = yield* operatorWrites(room.id, members, "Bo, the venue is booked.", to(bo));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        DELETE FROM room_members WHERE room_id = ${room.id} AND bot_id = ${bo.bot.id}
      `.pipe(Effect.orDie);
      yield* operatorWrites(room.id, members, "Cy, pick a date.", to(cy));
      yield* finish(hal, first, members);

      yield* nextTurn(cy.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Cy"]);
      assert.deepStrictEqual(yield* roomWakeStatuses(bo.bot.id, room.id), ["cancelled"]);
      yield* deliveryIs(forBo, "cancelled");
      for (const left of [ana, bo]) {
        assert.deepStrictEqual(yield* received(left.session), []);
      }
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("settles a room message whose only recipient was deleted before it received it", () =>
  Effect.gen(function* () {
    const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
    const members = [hal, ana, bo];
    const room = yield* roomWith(hal, [ana, bo]);
    yield* operatorWrites(room.id, members, "Plan the offsite.", to(hal));
    yield* nextTurn(hal.bot.id);
    // Ana's wake waits for Hal's turn when Ana is deleted.
    const forAna = yield* operatorWrites(room.id, members, "Ana, book the venue.", to(ana));
    yield* (yield* Bots).remove({ commandId: command(), botId: ana.bot.id, deleteFiles: true });
    yield* deliveryIs(forAna, "cancelled");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows in the room that a member's turn never ran when its dispatch was refused, and shows that member the entries again",
  () =>
    Effect.gen(function* () {
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const halTurn = yield* nextTurn(hal.bot.id);
      yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
      yield* (yield* TestEngineControl).rejectNextDispatch;
      yield* finish(hal, halTurn, members);

      yield* until(Effect.map(noticesIn(room.id), (notices) => notices.length > 0));
      assert.deepStrictEqual(yield* noticesIn(room.id), [
        { _tag: "turn-failed", failure: "unknown" },
      ]);

      // What the refused envelope carried was never seen: the next one has it.
      yield* operatorWrites(room.id, members, "Ana, any luck?", to(ana));
      yield* nextTurn(ana.bot.id);
      const envelope = yield* lastEnvelope(ana);
      assert.include(envelope, "Ana, find the numbers.");
      assert.include(envelope, "Ana, any luck?");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a member again the entries of a room dispatch a Stop released unsent", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
    const halTurn = yield* nextTurn(hal.bot.id);
    yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });

    // Ana's dispatch is written and waits at her gate when she is stopped.
    const gate = yield* holdGate(ana.bot.id);
    yield* control.finishTurn({
      sessionId: hal.session,
      turnId: halTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(hal.bot.id);
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches WHERE bot_id = ${ana.bot.id}
          AND audience_room_id = ${room.id}
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      ),
    );
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.bot.id });
    yield* gate.release;
    yield* settle(members);
    assert.deepStrictEqual(yield* received(ana.session), []);

    yield* operatorWrites(room.id, members, "Ana, any luck?", to(ana));
    yield* nextTurn(ana.bot.id);
    assert.include(yield* lastEnvelope(ana), "Ana, find the numbers.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "counts as seen the entries of a room dispatch whose recovery gave up, as the engine may have it",
  () =>
    Effect.gen(function* () {
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* (yield* TestEngineControl).deferNextDispatch;
      const first = yield* operatorWrites(room.id, members, "Ana, find the numbers.", to(ana));
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(first, "failed");

      yield* operatorWrites(room.id, members, "Ana, any luck?", to(ana));
      yield* nextTurn(ana.bot.id);
      const envelope = yield* lastEnvelope(ana);
      assert.include(envelope, "Ana, any luck?");
      assert.notInclude(envelope, "Ana, find the numbers.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "chooses a room envelope's closing line by the wakes it carries, not those left for the next",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      // Ana is busy elsewhere throughout, so only Hal takes the room's turns.
      yield* sendToBot(ana.bot.id, "Check the docs.");
      yield* nextTurn(ana.bot.id);
      yield* sendToBot(hal.bot.id, "Check the build.");
      const privateTurn = yield* nextTurn(hal.bot.id);
      // Two messages for Hal, too long to share one envelope: the first
      // mentions Hal, the second nobody.
      const long = "y".repeat(70_000);
      yield* operatorWrites(room.id, members, `Hal, read this. ${long}`, to(hal));
      yield* operatorWrites(room.id, members, `Anyone? ${long}`, nobody);
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: privateTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(hal.bot.id);
      yield* settle(members);

      // The first starts Hal's room turn, and the second, the operator's
      // word for the room it works for, steers that turn.
      yield* nextTurn(hal.bot.id, privateTurn);
      yield* until(Effect.map(received(hal.session), (all) => all.length === 3));
      const [, first, second] = yield* received(hal.session);
      assert.strictEqual(first?.delivery._tag, "start");
      assert.include(first?.text ?? "", "Hal, read this.");
      assert.notInclude(first?.text ?? "", "Anyone?");
      assert.include(first?.text ?? "", 'reason="addressed"');
      assert.strictEqual(second?.delivery._tag, "steer");
      assert.include(second?.text ?? "", "Anyone?");
      assert.include(second?.text ?? "", 'reason="user"');
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** The room's dispatches for the bot, oldest first: their status. */
const roomDispatchStatuses = (botId: BotId, roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM dispatches WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
      ORDER BY seq
    `.pipe(Effect.orDie);
    return rows.map((row) => row.status);
  });

/** The member's room turn fails at the usage limit, with a continuation pending for hours. */
const limitedAt = (one: Member, turnId: TurnId, members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    const at = DateTime.addDuration(yield* DateTime.now, Duration.hours(5));
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: one.session,
      turnId,
      outcome: { _tag: "failed", failure: "usage-limit", retryAt: at },
      continuation: { resumesAt: at },
    });
    yield* turnEnded(one.bot.id);
    yield* settle(members);
  });

it.effect("sends no room dispatch written for a member that left before it was sent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [hal, ana, bo, cy] = [
      yield* member("Hal"),
      yield* member("Ana"),
      yield* member("Bo"),
      yield* member("Cy"),
    ];
    const members = [hal, ana, bo, cy];
    const room = yield* roomWith(hal, [ana, bo, cy]);
    /** The operator writes to the member, whose start waits at its gate. */
    const writeTo = (one: Member, text: string) =>
      Effect.gen(function* () {
        const gate = yield* holdGate(one.bot.id);
        const entryId = yield* (yield* Pipeline).sendMessage({
          commandId: command(),
          target: { _tag: "room", roomId: room.id },
          text,
          attachments: [],
          mentions: to(one),
        });
        yield* until(
          Effect.map(roomDispatchStatuses(one.bot.id, room.id), (all) => all.length > 0),
        );
        return { entryId, gate };
      });

    // Ana is removed from the room while her dispatch waits at her gate.
    const forAna = yield* writeTo(ana, "Ana, the budget is secret.");
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { members: [hal.bot.id, bo.bot.id, cy.bot.id] },
    });
    assert.deepStrictEqual(yield* roomDispatchStatuses(ana.bot.id, room.id), ["released"]);
    yield* forAna.gate.release;
    yield* settle(members);
    assert.deepStrictEqual(yield* received(ana.session), []);
    assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["cancelled"]);
    yield* deliveryIs(forAna.entryId, "cancelled");

    // Bo's membership ends behind the dispatch's back: its send refuses it.
    const forBo = yield* writeTo(bo, "Bo, the venue is booked.");
    yield* sql`
      DELETE FROM room_members WHERE room_id = ${room.id} AND bot_id = ${bo.bot.id}
    `.pipe(Effect.orDie);
    yield* forBo.gate.release;
    yield* settle(members);
    assert.deepStrictEqual(yield* received(bo.session), []);
    assert.deepStrictEqual(yield* roomWakeStatuses(bo.bot.id, room.id), ["cancelled"]);

    // Nothing of theirs holds the room.
    yield* operatorWrites(room.id, members, "Hal, wrap up.", to(hal));
    yield* nextTurn(hal.bot.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds a bot's room message while the provider is at its usage limit", () =>
  Effect.gen(function* () {
    const { providerId } = TestDomain.DEFAULT_MODEL;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
    const halTurn = yield* nextTurn(hal.bot.id);
    yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
    yield* providerIs(providerId, {
      _tag: "limited",
      resetsAt: DateTime.addDuration(yield* DateTime.now, Duration.hours(5)),
    });
    yield* finish(hal, halTurn, members);
    assert.deepStrictEqual(yield* received(ana.session), []);
    assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["pending"]);

    yield* providerIs(providerId, { _tag: "ready" });
    yield* settle(members);
    yield* nextTurn(ana.bot.id);
    assert.include(yield* lastEnvelope(ana), "Ana, find the numbers.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** What `sendMessage` answered, in a transaction rolled back so the probe writes nothing. */
class Probe extends Schema.TaggedError<Probe>()("Probe", { accepted: Schema.Boolean }) {}

/** Text as long as allowed, of the character an envelope escapes into its longest entity. */
const widestText = (length: number) => '"'.repeat(length);

it.effect(
  "dispatches a room message accepted at the engine's limit after the room was renamed and given members",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* Pipeline;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, [hal, ana], "Plan the launch.", to(hal));
      const halTurn = yield* nextTurn(hal.bot.id);

      // Text that reads as envelope tags renders longer than it is written,
      // so a message well under the length limit can reach the engine's.
      const textOf = (units: number) => "<j3 ".repeat(units);
      const accepts = (units: number) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const sent = yield* Effect.exit(
                pipeline.sendMessage({
                  commandId: command(),
                  target: { _tag: "room", roomId: room.id },
                  text: textOf(units),
                  attachments: [],
                  mentions: to(ana),
                }),
              );
              return yield* new Probe({ accepted: Exit.isSuccess(sent) });
            }),
          )
          .pipe(
            Effect.catchTag("Probe", (probe) => Effect.succeed(probe.accepted)),
            Effect.orDie,
          );
      let [low, high] = [1, MAX_MESSAGE_LENGTH / 4];
      assert.isTrue(yield* accepts(low));
      assert.isFalse(yield* accepts(high));
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (yield* accepts(middle)) low = middle;
        else high = middle;
      }
      const atBound = yield* pipeline.sendMessage({
        commandId: command(),
        target: { _tag: "room", roomId: room.id },
        text: textOf(low),
        attachments: [],
        mentions: to(ana),
      });

      // Before Ana's wake goes, the room gets its longest name and as many
      // members as it can have, with names as long as they can be.
      const joined: Array<Member> = [];
      for (let index = 0; index < 4; index++) joined.push(yield* member(widestText(40)));
      const members = [hal, ana, ...joined];
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { name: widestText(200), members: members.map((one) => one.bot.id) },
      });
      yield* finish(hal, halTurn, members);

      yield* nextTurn(ana.bot.id);
      assert.include(yield* lastEnvelope(ana), "j3 ");
      yield* deliveryIs(atBound, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the operator's room message delivered to the members it reached when another left before receiving it",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Plan the offsite.", to(hal));
      const halTurn = yield* nextTurn(hal.bot.id);
      const both = yield* operatorWrites(room.id, members, "Ana and Bo, pick a date.", to(ana, bo));
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      yield* deliveryIs(both, "pending");
      yield* finish(hal, halTurn, members);
      yield* nextTurn(bo.bot.id);
      yield* deliveryIs(both, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "leaves the room without a failure notice when the operator's message shows the member's failed dispatch",
  () =>
    Effect.gen(function* () {
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const halTurn = yield* nextTurn(hal.bot.id);
      yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
      // Ana's wakes, Hal's message and the operator's word, go together.
      const asked = yield* operatorWrites(room.id, members, "Ana, use last year's too.", to(ana));
      yield* (yield* TestEngineControl).rejectNextDispatch;
      yield* finish(hal, halTurn, members);

      yield* deliveryIs(asked, "failed");
      assert.deepStrictEqual(yield* noticesIn(room.id), []);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** An operator's file, stored and not yet sent. */
const storedFile = (name: string) =>
  Effect.gen(function* () {
    return yield* (yield* Attachments).store({
      name,
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(`The contents of ${name}.`),
    });
  });

/** The operator writes in the room with files, and nothing waits for it to go. */
const operatorSends = (
  roomId: RoomId,
  text: string,
  mentions: Mentions,
  files: ReadonlyArray<Attachment>,
) =>
  Effect.gen(function* () {
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "room", roomId },
      text,
      attachments: files.map((file) => file.id),
      mentions,
    });
  });

/** Whether the file was copied into the member's inbox. */
const inInbox = (one: Member, file: Attachment) =>
  Effect.gen(function* () {
    const target = (yield* Path.Path).join((yield* Layout).workspace(one.bot.id), inboxPath(file));
    return yield* (yield* FileSystem.FileSystem).exists(target);
  });

it.effect(
  "copies no more of a room dispatch's files into a member's inbox once it left the room while one staged",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const [budget, salaries] = [
        yield* storedFile("budget.txt"),
        yield* storedFile("salaries.txt"),
      ];

      // Ana's first file is copied and staged, and the engine holds the stage.
      const staging = yield* control.holdNext("stageAttachment");
      const message = yield* operatorSends(room.id, "Ana, read both.", to(ana), [budget, salaries]);
      yield* staging.entered;
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      yield* staging.release;
      yield* settle(members);

      assert.isTrue(yield* inInbox(ana, budget));
      assert.isFalse(yield* inInbox(ana, salaries));
      assert.deepStrictEqual(yield* received(ana.session), []);
      assert.deepStrictEqual(yield* roomDispatchStatuses(ana.bot.id, room.id), ["released"]);
      yield* deliveryIs(message, "cancelled");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives back a teammate's room start the usage limit reached while its files staged, and sends it after",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { providerId } = TestDomain.DEFAULT_MODEL;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorSends(room.id, "Hal, read the plan.", to(hal), [
        yield* storedFile("plan.txt"),
      ]);
      yield* settle(members);
      const halTurn = yield* nextTurn(hal.bot.id);
      yield* say(hal, halTurn, { text: "Ana, check the plan's numbers.", mention: [ana.bot.id] });

      // Ana's start carries the operator's file, which she has not seen, and
      // the limit is reached while the engine holds its stage.
      const staging = yield* control.holdNext("stageAttachment");
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: halTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(hal.bot.id);
      yield* staging.entered;
      yield* providerIs(providerId, {
        _tag: "limited",
        resetsAt: DateTime.addDuration(yield* DateTime.now, Duration.hours(5)),
      });
      yield* staging.release;
      yield* settle(members);
      assert.deepStrictEqual(yield* received(ana.session), []);
      assert.deepStrictEqual(yield* roomDispatchStatuses(ana.bot.id, room.id), ["released"]);
      assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["pending"]);

      yield* providerIs(providerId, { _tag: "ready" });
      yield* settle(members);
      yield* nextTurn(ana.bot.id);
      assert.include(yield* lastEnvelope(ana), "Ana, check the plan's numbers.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("plans a teammate's room message held by a usage limit at the limit's reset", () =>
  Effect.gen(function* () {
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
    const halTurn = yield* nextTurn(hal.bot.id);
    yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
    // Hal's turn ends at the usage limit, which resets in half a minute.
    const resetsIn = Duration.seconds(30);
    const resetsAt = DateTime.addDuration(yield* DateTime.now, resetsIn);
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: hal.session,
      turnId: halTurn,
      outcome: { _tag: "failed", failure: "usage-limit", retryAt: resetsAt },
    });
    yield* turnEnded(hal.bot.id);
    yield* settle(members);
    assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["pending"]);

    // The dispatcher looks again at the reset, well before its heartbeat.
    yield* TestClock.adjust(Duration.sum(resetsIn, Duration.seconds(1)));
    yield* nextTurn(ana.bot.id);
    assert.include(yield* lastEnvelope(ana), "Ana, find the numbers.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the operator's room message delivered to the members it reached once a member whose dispatch failed left",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      // Ana comes first of those it wakes, so the refused dispatch is hers.
      yield* (yield* TestEngineControl).rejectNextDispatch;
      const both = yield* operatorWrites(room.id, members, "Ana and Bo, pick a date.", to(ana, bo));
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* finish(bo, boTurn, members);
      yield* deliveryIs(both, "failed");

      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      yield* deliveryIs(both, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "retries the operator's room message only to the members still in the room when one whose dispatch failed left",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const pipeline = yield* Pipeline;
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      // The engine refuses Ana's dispatch, and then Bo's, whose send waits
      // until Ana's has failed.
      yield* control.rejectNextDispatch;
      const gate = yield* holdGate(bo.bot.id);
      const both = yield* pipeline.sendMessage({
        commandId: command(),
        target: { _tag: "room", roomId: room.id },
        text: "Ana and Bo, pick a date.",
        attachments: [],
        mentions: to(ana, bo),
      });
      yield* until(
        Effect.map(roomWakeStatuses(ana.bot.id, room.id), (all) => all.includes("failed")),
      );
      yield* control.rejectNextDispatch;
      yield* gate.release;
      yield* settle(members);
      yield* deliveryIs(both, "failed");

      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      yield* pipeline.retryMessage({ commandId: command(), entryId: both });
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
      yield* settle(members);
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* finish(bo, boTurn, members);
      yield* deliveryIs(both, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "takes a leaving member's other wakes as soon as its room start never sent is released",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      // Ana's file fails to stage: her room start waits for its deadline, unsent,
      // and her private message waits behind it.
      const staging = yield* control.holdNext("stageAttachment");
      yield* operatorSends(room.id, "Ana, read the notes.", to(ana), [
        yield* storedFile("notes.txt"),
      ]);
      yield* staging.entered;
      yield* control.loseNextReply;
      yield* staging.release;
      yield* gateSettled(ana.bot.id);
      const flight = yield* sendToBot(ana.bot.id, "Book my flight.");
      yield* settle(members);
      yield* deliveryIs(flight, "pending");

      // Nothing but the removal tells the dispatcher, whose heartbeat the test
      // clock never reaches.
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      yield* nextTurn(ana.bot.id);
      assert.include(yield* lastEnvelope(ana), "Book my flight.");
      assert.isFalse(yield* sawText(ana, "Ana, read the notes."));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives back a room start that cannot get a turn slot when it is due, and sends it later with what the room said meanwhile",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      yield* concurrentTurns(2);
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Bo, translate the docs.", to(bo));
      const limited = yield* nextTurn(bo.bot.id);
      yield* limitedAt(bo, limited, members);

      // Ana's file fails to stage: her start waits for its deadline, unsent.
      const staging = yield* control.holdNext("stageAttachment");
      yield* operatorSends(room.id, "Ana, read the notes.", to(ana), [
        yield* storedFile("notes.txt"),
      ]);
      yield* staging.entered;
      yield* control.loseNextReply;
      yield* staging.release;
      yield* gateSettled(ana.bot.id);

      // Bo's pending continuation holds the only slot there is, and the
      // operator's word to Bo goes beside it.
      yield* concurrentTurns(1);
      yield* operatorWrites(room.id, members, "Bo, any news?", to(bo));
      const boTurn = yield* nextTurn(bo.bot.id, limited);

      // Ana's start falls due with no slot for it: it is given back, unsent.
      yield* TestClock.adjust(recoveryBackoff(1));
      yield* settle(members);
      assert.deepStrictEqual(yield* roomDispatchStatuses(ana.bot.id, room.id), ["released"]);
      yield* say(bo, boTurn, { text: "Half the docs are translated." });

      // Once Bo's turn ends, the slot is free: Ana's message goes, with what
      // Bo said while it waited.
      yield* finish(bo, boTurn, members);
      yield* nextTurn(ana.bot.id);
      const envelope = yield* lastEnvelope(ana);
      assert.include(envelope, "Ana, read the notes.");
      assert.include(envelope, "Half the docs are translated.");
      assert.strictEqual((yield* received(ana.session)).length, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);
