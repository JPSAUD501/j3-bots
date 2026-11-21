// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type Bot,
  type BotId,
  type Entry,
  EntryOrder,
  MAX_MESSAGE_LENGTH,
  type Mentions,
  type Notice,
  type RoomId,
} from "@j3-bots/contracts";
import { ENGINE_INPUT_LIMIT, type SessionId, type TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Bots } from "../bots/Bots.ts";
import { Entries } from "../entries/Entries.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  admittedTurn,
  chainLimits,
  command,
  concurrentTurns,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  holdGate,
  nextTurn,
  providerIs,
  received,
  recoverTimes,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { MAX_INDETERMINATE_ANSWERS } from "../turns/model.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { Stops } from "../turns/Stops.ts";
import { Rooms } from "./Rooms.ts";

/** A member as a test drives it: the bot and the engine session it works in. */
interface Member {
  readonly bot: Bot;
  readonly session: SessionId;
}

/** A new bot past its first turn, as a member to drive. */
const member = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    return { bot, session: yield* engineSession(bot.id) } satisfies Member;
  });

/** A room of these members, in this order, hosted by `host`. */
const roomWith = (host: Member, others: ReadonlyArray<Member>, hopLimit?: number) =>
  Effect.gen(function* () {
    return yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [host, ...others].map((one) => one.bot.id),
      hostId: host.bot.id,
      ...(hopLimit === undefined ? {} : { hopLimit }),
    });
  });

/** The operator writes in the room, and every member's wakes that can go have gone. */
const operatorWrites = (
  roomId: RoomId,
  members: ReadonlyArray<Member>,
  text: string,
  mentions: Mentions,
) =>
  Effect.gen(function* () {
    const entryId = yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "room", roomId },
      text,
      attachments: [],
      mentions,
    });
    yield* settle(members);
    return entryId;
  });

/** Every member's session took what it can take now. */
const settle = (members: ReadonlyArray<Member>) =>
  Effect.forEach(members, (member) => flushed(member.bot.id), { discard: true });

let calls = 0;

/** What a test's `say` passes. */
interface SayArgs {
  readonly text: string;
  readonly mention?: ReadonlyArray<string>;
  readonly to?: "dm";
  readonly done?: boolean;
}

/** The member, in its running turn, calls `say`: the response the tool gives it. */
const say = (member: Member, turnId: TurnId, args: SayArgs) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: member.session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `room-call-${++calls}`,
      sessionId: member.session,
      tool: "say",
      arguments: { ...args },
    });
  });

/** The member's running turn ends, and every member's wakes that can go have gone. */
const finish = (member: Member, turnId: TurnId, members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: member.session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(member.bot.id);
    yield* settle(members);
  });

/** The envelopes the member's session received, oldest first. */
const envelopes = (member: Member) =>
  Effect.map(received(member.session), (all) => all.map((dispatch) => dispatch.text));

/** The newest envelope the member received. */
const lastEnvelope = (member: Member) => Effect.map(envelopes(member), (all) => all.at(-1) ?? "");

/**
 * Which members run a turn now: a room runs one at a time, so a test asserts
 * this is exactly the member it expects at every step.
 */
const running = (members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    const names: Array<string> = [];
    for (const member of members) {
      if (Option.isSome(yield* admittedTurn(member.bot.id))) names.push(member.bot.profile.name);
    }
    return names;
  });

/** The room's live work: its dispatches not settled and its turns not finished. */
const liveRoomWork = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT
        (SELECT COUNT(*) FROM dispatches
          WHERE audience_room_id = ${roomId} AND status IN ('intended', 'accepted', 'delivered'))
        + (SELECT COUNT(*) FROM turns WHERE audience_room_id = ${roomId} AND finished_at IS NULL)
        AS n
    `.pipe(Effect.orDie);
    return row?.n ?? 0;
  });

/** How many wakes the room ever gave the bot. */
const roomWakesOf = (botId: BotId, roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM wakes WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
    `.pipe(Effect.orDie);
    return row?.n ?? 0;
  });

/** The room's entries, oldest first. */
const roomEntries = (roomId: RoomId) =>
  Effect.gen(function* () {
    const page = yield* (yield* Entries).history({
      target: { _tag: "room", roomId },
      before: EntryOrder.make(Number.MAX_SAFE_INTEGER),
      limit: 500,
    });
    return page.entries;
  });

const noticesIn = (roomId: RoomId) =>
  Effect.map(roomEntries(roomId), (entries) =>
    entries.flatMap((entry: Entry): ReadonlyArray<Notice> =>
      entry._tag === "notice" ? [entry.notice] : [],
    ),
  );

const nobody: Mentions = { _tag: "bots", ids: [] };

const to = (...members: ReadonlyArray<Member>): Mentions => ({
  _tag: "bots",
  ids: members.map((one) => one.bot.id),
});

/** The status of each room wake the bot was given, oldest first. */
const roomWakeStatuses = (botId: BotId, roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM wakes WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
      ORDER BY rowid
    `.pipe(Effect.orDie);
    return rows.map((row) => row.status);
  });

/** Whether any envelope the member received carries the text. */
const sawText = (member: Member, text: string) =>
  Effect.map(envelopes(member), (all) => all.some((envelope) => envelope.includes(text)));

it.effect(
  "runs a room's work through its host, handing it on by mention, one turn at a time, without waking a bystander",
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

      // The operator addresses nobody: the host answers.
      const asked = yield* operatorWrites(room.id, members, "Write the launch note.", nobody);
      const halFirst = yield* nextTurn(hal.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      assert.include(yield* lastEnvelope(hal), 'reason="host"');
      yield* say(hal, halFirst, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
      yield* finish(hal, halFirst, members);

      const anaTurn = yield* nextTurn(ana.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      assert.include(yield* lastEnvelope(ana), "Ana, find the numbers.");
      yield* say(ana, anaTurn, {
        text: "Revenue grew 12%. Bo, write it up.",
        mention: [bo.bot.id],
      });
      yield* finish(ana, anaTurn, members);

      const boTurn = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      // Bo sees what was said before it, the operator's message included.
      const boEnvelope = yield* lastEnvelope(bo);
      assert.include(boEnvelope, "Write the launch note.");
      assert.include(boEnvelope, "Revenue grew 12%.");
      yield* say(bo, boTurn, { text: "Draft in files/note.md. Hal?", mention: [hal.bot.id] });
      yield* finish(bo, boTurn, members);

      const halLast = yield* nextTurn(hal.bot.id, halFirst);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      // Only what Hal has not seen: what Ana and Bo said since its turn.
      const halEnvelope = yield* lastEnvelope(hal);
      assert.notInclude(halEnvelope, "Write the launch note.");
      assert.include(halEnvelope, "Revenue grew 12%.");
      assert.include(halEnvelope, "Draft in files/note.md.");
      yield* say(hal, halLast, { text: "Done: the note is ready.", done: true });
      yield* finish(hal, halLast, members);

      // Mentioning nobody wakes nobody: the room is quiet.
      assert.deepStrictEqual(yield* running(members), []);
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
      const sql = yield* SqlClient.SqlClient;
      const turns = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM turns WHERE audience_room_id = ${room.id}
      `.pipe(Effect.orDie);
      assert.strictEqual(turns[0]?.n, 4);
      assert.strictEqual(yield* roomWakesOf(cy.bot.id, room.id), 0);
      assert.deepStrictEqual(yield* received(cy.session), []);
      yield* deliveryIs(asked, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "wakes the members the operator mentions in the order mentioned, and everyone in member order, each seeing the replies before it",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      yield* operatorWrites(room.id, members, "Bo, then Ana: one line each.", {
        _tag: "bots",
        ids: [bo.bot.id, ana.bot.id],
      });
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      yield* finish(bo, boTurn, members);
      const anaTurn = yield* nextTurn(ana.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      yield* finish(ana, anaTurn, members);
      // The host was not mentioned, so it was not woken.
      assert.strictEqual(yield* roomWakesOf(hal.bot.id, room.id), 0);

      yield* operatorWrites(room.id, members, "Everyone: your status?", { _tag: "everyone" });
      const replies: Array<string> = [];
      for (const member of members) {
        const turnId = yield* nextTurn(member.bot.id, null);
        assert.deepStrictEqual(yield* running(members), [member.bot.profile.name]);
        const envelope = yield* lastEnvelope(member);
        assert.include(envelope, 'reason="everyone"');
        for (const reply of replies) assert.include(envelope, reply);
        const reply = `${member.bot.profile.name} is on track.`;
        yield* say(member, turnId, { text: reply });
        replies.push(reply);
        yield* finish(member, turnId, members);
      }
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
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
    yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId: ana.bot.id },
      text: "Check the build.",
      attachments: [],
    });
    const privateTurn = yield* nextTurn(ana.bot.id);
    const toAna: Mentions = { _tag: "bots", ids: [ana.bot.id] };
    yield* operatorWrites(room.id, all, "First launch question.", toAna);
    yield* operatorWrites(other.id, all, "An ops question.", toAna);
    yield* operatorWrites(room.id, all, "Second launch question.", toAna);
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
    yield* operatorWrites(room.id, members, "Draft the agenda.", nobody);
    const turnId = yield* nextTurn(hal.bot.id);
    yield* operatorWrites(room.id, members, "Keep it short.", nobody);

    const [first, steer] = yield* received(hal.session);
    assert.strictEqual(first?.delivery._tag, "start");
    assert.strictEqual(steer?.delivery._tag, "steer");
    assert.include(steer?.text ?? "", "Keep it short.");
    assert.deepStrictEqual(yield* admittedTurn(hal.bot.id), Option.some(turnId));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "stops a chain of mentions at the room's hop limit, with one notice and no wake to report it",
  () =>
    Effect.gen(function* () {
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo], 2);
      yield* operatorWrites(room.id, members, "Ana, settle the date with Bo.", {
        _tag: "bots",
        ids: [ana.bot.id],
      });

      // Ana and Bo hand the work back and forth: hops 1 and 2 are taken.
      const first = yield* nextTurn(ana.bot.id);
      yield* say(ana, first, { text: "Bo, Tuesday?", mention: [bo.bot.id] });
      yield* finish(ana, first, members);
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* say(bo, boTurn, { text: "Ana, Wednesday?", mention: [ana.bot.id] });
      yield* finish(bo, boTurn, members);
      const second = yield* nextTurn(ana.bot.id, first);
      const stopped = yield* say(ana, second, { text: "Bo, Thursday?", mention: [bo.bot.id] });
      const again = yield* say(ana, second, { text: "Bo, Friday?", mention: [bo.bot.id] });
      yield* finish(ana, second, members);

      // The messages are in the room; the third hop woke nobody.
      for (const response of [stopped, again]) {
        assert.strictEqual(response._tag, "result");
        assert.include(JSON.stringify(response), "limit of 2");
      }
      assert.strictEqual(yield* roomWakesOf(bo.bot.id, room.id), 1);
      assert.deepStrictEqual(yield* noticesIn(room.id), [{ _tag: "chain-stopped", limit: "hops" }]);
      assert.deepStrictEqual(yield* running(members), []);
      assert.strictEqual(yield* liveRoomWork(room.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a mention past the fan-out limit, of itself, of a non-member or outside a room turn, writing nothing",
  () =>
    Effect.gen(function* () {
      yield* chainLimits({ hops: 4, fanOut: 1 });
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const outsider = yield* createBot("Cy");
      yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
      const turnId = yield* nextTurn(hal.bot.id);
      const entriesBefore = (yield* roomEntries(room.id)).length;

      const refusals = [
        { mention: [ana.bot.id, bo.bot.id], says: "at most 1 member" },
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
    yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId: hal.bot.id },
      text: "Ask Ana for the numbers.",
      attachments: [],
    });
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
      yield* (yield* Pipeline).sendMessage({
        commandId: command(),
        target: { _tag: "conversation", botId: ana.bot.id },
        text: "Check the build.",
        attachments: [],
      });
      const privateTurn = yield* nextTurn(ana.bot.id);
      const question = "Ana, what did Hal decide?";
      const asked = yield* operatorWrites(room.id, members, question, {
        _tag: "bots",
        ids: [ana.bot.id],
      });
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
      yield* operatorWrites(room.id, members, "Deploy the site.", nobody);
      const turnId = yield* nextTurn(hal.bot.id);
      yield* (yield* TestEngineControl).openRequest({
        sessionId: hal.session,
        turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action: "deploy --prod",
          detail: null,
          reason: null,
          exact: true,
          sessionGrant: null,
        },
      });
      yield* (yield* TestEngineControl).openRequest({
        sessionId: hal.session,
        turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action: "deploy --staging",
          detail: null,
          reason: null,
          exact: true,
          sessionGrant: null,
        },
      });
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

it.effect(
  "runs other members while one's room turn waits for a usage limit's reset, and still takes the operator's word to it",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Ana, translate the docs.", to(ana));
      const limited = yield* nextTurn(ana.bot.id);
      const at = yield* DateTime.now;
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: ana.session,
        turnId: limited,
        outcome: {
          _tag: "failed",
          failure: "usage-limit",
          retryAt: DateTime.addDuration(at, Duration.hours(5)),
        },
        continuation: { resumesAt: DateTime.addDuration(at, Duration.hours(5)) },
      });
      yield* turnEnded(ana.bot.id);
      yield* settle(members);

      // Ana's turn waits hours for the reset; Bo answers meanwhile.
      yield* operatorWrites(room.id, members, "Bo, check the links.", to(bo));
      const boTurn = yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
      yield* finish(bo, boTurn, members);

      // The operator's word to Ana goes now, as it does in private.
      const skip = yield* operatorWrites(room.id, members, "Ana, skip the appendix.", to(ana));
      yield* nextTurn(ana.bot.id, limited);
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
      yield* operatorWrites(room.id, members, "Draft the agenda.", nobody);
      yield* nextTurn(hal.bot.id);
      // Older, and for Hal's conversation: it waits for the room turn to end.
      const flight = yield* sendToBot(hal.bot.id, "Book my flight.");
      yield* operatorWrites(room.id, members, "Keep it short.", nobody);

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
      yield* operatorWrites(room.id, members, "Plan the offsite.", nobody);
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
    yield* operatorWrites(room.id, members, "Plan the offsite.", nobody);
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
      yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
    yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
      yield* sendToBot(hal.bot.id, "Check the build.");
      const privateTurn = yield* nextTurn(hal.bot.id);
      // Two messages for Hal, too long to share one envelope: the first
      // mentions Hal, the second addresses nobody, so Hal hosts it.
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

      const mentioned = yield* nextTurn(hal.bot.id, privateTurn);
      const first = yield* lastEnvelope(hal);
      assert.include(first, "Hal, read this.");
      assert.notInclude(first, "Anyone?");
      assert.include(first, 'reason="mentioned"');
      yield* finish(hal, mentioned, members);

      yield* nextTurn(hal.bot.id, mentioned);
      const second = yield* lastEnvelope(hal);
      assert.include(second, "Anyone?");
      assert.include(second, 'reason="host"');
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

it.effect(
  "lets the operator's word to a member that holds a turn slot go first while the room's next member cannot get one",
  () =>
    Effect.gen(function* () {
      const [hal, bo, ana] = [yield* member("Hal"), yield* member("Bo"), yield* member("Ana")];
      const members = [hal, bo, ana];
      const room = yield* roomWith(hal, [bo, ana]);
      yield* operatorWrites(room.id, members, "Ana, translate the docs.", to(ana));
      const limited = yield* nextTurn(ana.bot.id);
      yield* limitedAt(ana, limited, members);
      // Ana's pending continuation holds the one slot there is.
      yield* concurrentTurns(1);

      yield* operatorWrites(room.id, members, "Status, everyone?", { _tag: "everyone" });
      const anaTurn = yield* nextTurn(ana.bot.id, limited);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);
      assert.include(yield* lastEnvelope(ana), "Status, everyone?");
      yield* finish(ana, anaTurn, members);

      // The slot is free: the rest go in member order.
      const halTurn = yield* nextTurn(hal.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Hal"]);
      yield* finish(hal, halTurn, members);
      yield* nextTurn(bo.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Bo"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds a room start written before another member's continuation resumed until that turn ends",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Ana, translate the docs.", to(ana));
      const limited = yield* nextTurn(ana.bot.id);
      yield* limitedAt(ana, limited, members);

      // Bo's start is written while Ana's turn waits for the reset, and
      // waits at Bo's gate while the engine resumes Ana's turn.
      const gate = yield* holdGate(bo.bot.id);
      yield* (yield* Pipeline).sendMessage({
        commandId: command(),
        target: { _tag: "room", roomId: room.id },
        text: "Bo, check the links.",
        attachments: [],
        mentions: to(bo),
      });
      yield* until(Effect.map(roomDispatchStatuses(bo.bot.id, room.id), (all) => all.length > 0));
      const resumed = yield* control.resumeContinuation({
        sessionId: ana.session,
        turnId: limited,
      });
      yield* nextTurn(ana.bot.id, limited);
      yield* gate.release;
      yield* settle(members);
      assert.deepStrictEqual(yield* received(bo.session), []);
      assert.deepStrictEqual(yield* running(members), ["Ana"]);

      // Bo goes once Ana's turn ended, seeing what it said.
      yield* say(ana, resumed, { text: "The docs are translated." });
      yield* finish(ana, resumed, members);
      yield* nextTurn(bo.bot.id);
      assert.include(yield* lastEnvelope(bo), "The docs are translated.");
      const [sent] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches WHERE bot_id = ${bo.bot.id} AND attempts > 0
          AND audience_room_id = ${room.id}
      `.pipe(Effect.orDie);
      assert.strictEqual(sent?.n, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

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

it.effect("holds a bot's room mention while the provider is at its usage limit", () =>
  Effect.gen(function* () {
    const { providerId } = TestDomain.DEFAULT_MODEL;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
      yield* operatorWrites(room.id, [hal, ana], "Plan the launch.", nobody);
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
      yield* operatorWrites(room.id, members, "Plan the offsite.", nobody);
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
      yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
      const halTurn = yield* nextTurn(hal.bot.id);
      yield* say(hal, halTurn, { text: "Ana, find the numbers.", mention: [ana.bot.id] });
      // Ana's wakes, Hal's mention and the operator's word, go together.
      const asked = yield* operatorWrites(room.id, members, "Ana, use last year's too.", to(ana));
      yield* (yield* TestEngineControl).rejectNextDispatch;
      yield* finish(hal, halTurn, members);

      yield* deliveryIs(asked, "failed");
      assert.deepStrictEqual(yield* noticesIn(room.id), []);
    }).pipe(Effect.provide(TestDomain.layer)),
);
