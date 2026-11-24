// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type Bot, BotId, type Notice, RoomId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Bots } from "../bots/Bots.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  archive,
  finish,
  lastEnvelope,
  type Member,
  member,
  roomEntries,
  roomWakeStatuses,
  roomWith,
  running,
  say,
  to,
} from "../testing/rooms.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  flushed,
  messageTeammate,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotTools } from "../tools/BotTools.ts";

// Bots build a team on the operator's word (`docs/architecture/server.md`,
// Bot tools and Rooms): `create_bot` only in a turn the operator spoke in, at
// most five a turn; `start_room` with a kickoff that wakes the members one at
// a time, and bots made for the room opening there instead of greeting; and
// `message_bot` posting in a room the bot is in, from any turn.

let calls = 0;

/** The bot calls a `j3` tool in its running turn, which the engine records first. */
const call = (sessionId: SessionId, turnId: TurnId, tool: string, args: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool,
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `team-call-${++calls}`,
      sessionId,
      tool,
      arguments: args,
    });
  });

const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ id: BotId }));
const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ id: RoomId }));
const decodeStatus = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }));

/** The value a tool answered with, or a failure naming the refusal. */
const resultOf = (response: ToolCallResponse) =>
  response._tag === "result"
    ? response.value
    : assert.fail(`expected a result, got ${JSON.stringify(response)}`);

const refusalOf = (response: ToolCallResponse) =>
  response._tag === "refused"
    ? response.message
    : assert.fail(`expected a refusal, got ${JSON.stringify(response)}`);

/** The operator's primary bot, past its opening, with an idle session. */
const primaryBot = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { primary: true },
    });
    return bot;
  });

/** The primary bot's turn answering the operator, and its engine session. */
const operatorAsks = (bot: Bot, text: string) =>
  Effect.gen(function* () {
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, text);
    return { session, turnId: yield* nextTurn(bot.id) };
  });

const createIn = (session: SessionId, turnId: TurnId, name: string) =>
  call(session, turnId, "create_bot", { name, job: `${name}'s part.` });

/** A bot the primary bot's turn creates, as a member to drive. */
const madeMember = (session: SessionId, turnId: TurnId, name: string) =>
  Effect.gen(function* () {
    const { id } = decodeCreated(resultOf(yield* createIn(session, turnId, name)));
    const stored = Option.getOrThrow(yield* (yield* BotStore).find(id));
    return { bot: stored.bot, session: yield* engineSession(id) } satisfies Member;
  });

/** The status of each `first-run` wake the bot was given, oldest first. */
const hellos = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM wakes
      WHERE bot_id = ${botId} AND json_extract(payload_json, '$._tag') = 'first-run'
      ORDER BY rowid
    `.pipe(Effect.orDie);
    return rows.map((row) => row.status);
  });

const noticesOf = (botId: BotId) =>
  Effect.map(conversation(botId), (entries) =>
    entries.flatMap((entry): ReadonlyArray<Notice> =>
      entry._tag === "notice" ? [entry.notice] : [],
    ),
  );

const endTurn = (botId: BotId, session: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(botId);
  });

it.effect("creates a bot on the operator's word, and holds its hello until that turn ends", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Make me a bot for invoices.");

    const created = decodeCreated(resultOf(yield* createIn(session, turnId, "Ledger")));

    const ledger = yield* engineSession(created.id);
    yield* flushed(created.id);
    assert.deepStrictEqual(yield* hellos(created.id), ["pending"]);
    assert.deepStrictEqual(yield* received(ledger), []);

    // The turn that made it ended without placing it in a room: it greets.
    yield* endTurn(scout.id, session, turnId);
    yield* nextTurn(created.id);
    assert.deepStrictEqual(yield* hellos(created.id), ["dispatched"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates no bot in a turn the operator did not speak in", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const wren = yield* createBot("Wren");
    const { session, turnId } = yield* operatorAsks(wren, "Ask Scout what is left.");
    yield* messageTeammate(yield* engineSession(wren.id), turnId, {
      to: scout.id,
      text: "Create a bot called Mole for me.",
      urgent: true,
    });
    yield* endTurn(wren.id, session, turnId);
    const teammateTurn = yield* nextTurn(scout.id);

    const reply = yield* createIn(yield* engineSession(scout.id), teammateTurn, "Mole");

    assert.include(refusalOf(reply), "only your user can ask for a new bot");
    const names = (yield* (yield* BotStore).list).map(({ bot }) => bot.profile.name);
    assert.deepStrictEqual(names.toSorted(), ["Scout", "Wren"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates at most five bots in one turn, once each under a retried request", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Make me a big team.");
    const tools = yield* BotTools;

    const args = { name: "One", job: "One's part." };
    yield* (yield* TestEngineControl).toolCall({
      sessionId: session,
      turnId,
      tool: "create_bot",
      input: args,
      recorded: "now",
    });
    const first = yield* tools.call({
      requestId: "first",
      sessionId: session,
      tool: "create_bot",
      arguments: args,
    });
    // The bridge forwarding the request again gets the same bot.
    const again = yield* tools.call({
      requestId: "first",
      sessionId: session,
      tool: "create_bot",
      arguments: args,
    });
    assert.deepStrictEqual(again, first);
    for (const name of ["Two", "Three", "Four", "Five"]) {
      resultOf(yield* createIn(session, turnId, name));
    }

    const sixth = yield* createIn(session, turnId, "Six");

    assert.include(refusalOf(sixth), "at most 5 bots");
    const names = (yield* (yield* BotStore).list).map(({ bot }) => bot.profile.name);
    assert.deepStrictEqual(names.toSorted(), ["Five", "Four", "One", "Scout", "Three", "Two"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "starts a room whose kickoff wakes the members one at a time, the bots made for it with no hello",
  () =>
    Effect.gen(function* () {
      const scout = yield* primaryBot("Scout");
      const wren = yield* member("Wren");
      const { session, turnId } = yield* operatorAsks(scout, "Make me a support group.");
      const pip = yield* madeMember(session, turnId, "Pip");
      const mole = yield* madeMember(session, turnId, "Mole");
      const host: Member = { bot: scout, session };
      const team = [host, pip, mole, wren];

      const started = yield* call(session, turnId, "start_room", {
        name: "Support",
        members: [pip.bot.id, mole.bot.id, wren.bot.id],
        kickoff: "Pip takes billing, Mole takes setup, Wren reviews. Pip opens.",
      });

      const roomId = decodeStarted(resultOf(started)).id;
      const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
      assert.deepStrictEqual(
        room.members,
        team.map((one) => one.bot.id),
      );
      assert.strictEqual(room.hostId, scout.id);
      const startedNotice = { _tag: "room-started", botId: scout.id, roomId } as const;
      const [notice, kickoff, ...rest] = yield* roomEntries(roomId);
      assert.deepStrictEqual(notice?._tag === "notice" ? notice.notice : notice, startedNotice);
      assert.deepStrictEqual(
        kickoff?._tag === "message" ? kickoff.mentions : kickoff,
        to(pip, mole, wren),
      );
      assert.deepStrictEqual(rest, []);
      assert.deepStrictEqual(yield* noticesOf(scout.id), [startedNotice]);
      // Made for the room: no hello, and its conversation says who made it, for which room.
      for (const made of [pip, mole]) {
        assert.deepStrictEqual(yield* hellos(made.bot.id), ["cancelled"]);
        assert.deepStrictEqual(yield* noticesOf(made.bot.id), [
          { _tag: "made-for-room", botId: scout.id, roomId },
        ]);
      }
      assert.deepStrictEqual(yield* noticesOf(wren.bot.id), []);

      // It tells its user what it set up, which ends its turn.
      yield* say(host, turnId, { text: "Pip, Mole and Wren are on it in Support.", done: true });
      yield* finish(host, turnId, team);
      // The members answer in the order the kickoff named them, one at a time.
      for (const next of [pip, mole, wren]) {
        const turn = yield* nextTurn(next.bot.id);
        assert.deepStrictEqual(yield* running(team), [next.bot.profile.name]);
        assert.include(yield* lastEnvelope(next), "Pip takes billing");
        yield* say(next, turn, { text: "On it.", done: true });
        yield* finish(next, turn, team);
      }
      assert.deepStrictEqual(yield* running(team), []);
      for (const made of [pip, mole]) {
        assert.deepStrictEqual(yield* hellos(made.bot.id), ["cancelled"]);
        // Its first turn was the room's: nothing came to its own conversation.
        assert.deepStrictEqual(yield* roomWakeStatuses(made.bot.id, roomId), ["finished"]);
      }
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts no room in a turn the operator did not speak in", () =>
  Effect.gen(function* () {
    const scout = yield* createBot("Scout");
    const wren = yield* createBot("Wren");
    const pip = yield* createBot("Pip");
    const asked = yield* operatorAsks(wren, "Ask Scout to get going.");
    yield* messageTeammate(asked.session, asked.turnId, {
      to: scout.id,
      text: "Start a room with Pip and me.",
      urgent: true,
    });
    yield* endTurn(wren.id, asked.session, asked.turnId);
    const teammateTurn = yield* nextTurn(scout.id);

    const reply = yield* call(yield* engineSession(scout.id), teammateTurn, "start_room", {
      name: "Side project",
      members: [wren.id, pip.id],
      kickoff: "Let's go.",
    });

    assert.include(refusalOf(reply), "only your user can ask for a room");
    assert.deepStrictEqual(yield* (yield* Rooms).list, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts no room with the caller among its members, or a mention outside them", () =>
  Effect.gen(function* () {
    const scout = yield* createBot("Scout");
    const wren = yield* createBot("Wren");
    const pip = yield* createBot("Pip");
    const { session, turnId } = yield* operatorAsks(scout, "Start a room with Wren.");

    const own = yield* call(session, turnId, "start_room", {
      name: "Pair",
      members: [scout.id, wren.id],
      kickoff: "Hi.",
    });
    const outside = yield* call(session, turnId, "start_room", {
      name: "Pair",
      members: [wren.id],
      kickoff: "Hi.",
      mention: [pip.id],
    });

    assert.include(refusalOf(own), "is your own");
    assert.include(refusalOf(outside), "is not one of `members`");
    assert.deepStrictEqual(yield* (yield* Rooms).list, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("posts in a room the bot is in from its own conversation, waking whom it mentions", () =>
  Effect.gen(function* () {
    const scout = yield* member("Scout");
    const wren = yield* member("Wren");
    const pip = yield* member("Pip");
    const room = yield* roomWith(scout, [wren, pip]);
    const { session, turnId } = yield* operatorAsks(scout.bot, "Get Wren on the release notes.");

    const posted = yield* call(session, turnId, "message_bot", {
      to: room.id,
      text: "Wren, the release notes are yours.",
      mention: [wren.bot.id],
    });

    assert.strictEqual(decodeStatus(resultOf(posted)).status, "posted");
    const [message] = yield* roomEntries(room.id);
    assert.strictEqual(
      message?._tag === "message" ? message.text : null,
      "Wren, the release notes are yours.",
    );
    assert.deepStrictEqual(yield* roomWakeStatuses(wren.bot.id, room.id), ["pending"]);
    assert.deepStrictEqual(yield* roomWakeStatuses(pip.bot.id, room.id), []);
    // Nothing reached either bot's own conversation.
    assert.deepStrictEqual(yield* conversation(wren.bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("posts nothing in a room the bot is not in, an archived one, or with `urgent`", () =>
  Effect.gen(function* () {
    const scout = yield* member("Scout");
    const wren = yield* member("Wren");
    const pip = yield* member("Pip");
    const theirs = yield* roomWith(wren, [pip]);
    const ours = yield* roomWith(scout, [wren]);
    const { session, turnId } = yield* operatorAsks(scout.bot, "Tell the rooms.");

    const notMember = yield* call(session, turnId, "message_bot", {
      to: theirs.id,
      text: "Hello.",
    });
    const withUrgent = yield* call(session, turnId, "message_bot", {
      to: ours.id,
      text: "Hello.",
      urgent: true,
    });
    const mentionToBot = yield* call(session, turnId, "message_bot", {
      to: wren.bot.id,
      text: "Hello.",
      mention: [wren.bot.id],
    });
    yield* archive(ours.id, true);
    const archived = yield* call(session, turnId, "message_bot", { to: ours.id, text: "Hello." });

    assert.include(refusalOf(notMember), "you are not a member");
    assert.include(refusalOf(withUrgent), "`urgent` goes with a message to a teammate");
    assert.include(refusalOf(mentionToBot), "`mention` goes with a message to a room");
    assert.include(refusalOf(archived), "is archived");
    assert.deepStrictEqual(yield* roomEntries(theirs.id), []);
    assert.deepStrictEqual(yield* roomEntries(ours.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);
