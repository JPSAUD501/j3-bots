// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { RoomId, RoutineId } from "@j3-bots/contracts";
import { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Bots } from "../bots/Bots.ts";
import { Routines } from "../routines/Routines.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  archive,
  lastEnvelope,
  type Member,
  member,
  operatorWrites,
  roomEntries,
  roundsIn,
  roomWith,
  say,
  to,
} from "../testing/rooms.ts";
import {
  chainLimits,
  command,
  concurrentTurns,
  eventually,
  messageTeammate,
  nextTurn,
  noticesOf,
  sendToBot,
  sessionAfter,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";

// A bot reads its rooms from any turn, and a post to a room from outside
// that room's own turn goes out only on what the posting session has seen
// (`docs/architecture/server.md`, What a bot has seen of a room).

let calls = 0;

/** The engine records a `j3` tool call of the bot's running turn. */
const record = (sessionId: SessionId, turnId: TurnId, tool: string, args: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool,
      input: args,
      recorded: "now",
    });
  });

/** The server answers a call the engine recorded. */
const answer = (sessionId: SessionId, tool: string, args: Schema.Json) =>
  Effect.gen(function* () {
    return yield* (yield* BotTools).call({
      requestId: `read-call-${++calls}`,
      sessionId,
      tool,
      arguments: args,
    });
  });

/** The bot calls a `j3` tool in its running turn, which the engine records first. */
const call = (sessionId: SessionId, turnId: TurnId, tool: string, args: Schema.Json) =>
  Effect.andThen(record(sessionId, turnId, tool, args), answer(sessionId, tool, args));

/** What `read_room` answered: its text. */
const readOf = (response: ToolCallResponse) =>
  response._tag === "text" && !response.isError
    ? response.text
    : assert.fail(`expected a read, got ${JSON.stringify(response)}`);

const refusalOf = (response: ToolCallResponse) =>
  response._tag === "refused"
    ? response.message
    : assert.fail(`expected a refusal, got ${JSON.stringify(response)}`);

const decodeStatus = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }));

const statusOf = (response: ToolCallResponse) =>
  response._tag === "result"
    ? decodeStatus(response.value).status
    : assert.fail(`expected a result, got ${JSON.stringify(response)}`);

/** Whether a room post went in quiet: it is in the room, and the tool says it woke nobody. */
const wokeNobody = (response: ToolCallResponse) =>
  response._tag === "result" &&
  Schema.is(Schema.Struct({ stopped: Schema.Literal("room") }))(response.value);

/** The texts of the room's messages, oldest first. */
const roomTexts = (roomId: RoomId) =>
  Effect.map(roomEntries(roomId), (entries) =>
    entries.flatMap((entry) => (entry._tag === "message" ? [entry.text] : [])),
  );

/** The operator writes to the bot in its own conversation: the turn that answers. */
const operatorAsks = (bot: Member, text: string, previous: TurnId | null = null) =>
  Effect.gen(function* () {
    yield* sendToBot(bot.bot.id, text);
    return yield* nextTurn(bot.bot.id, previous);
  });

const endTurn = (bot: Member, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: bot.session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.bot.id);
  });

/**
 * Scout, Wren and Pip in one room. What the operator writes there is for Pip,
 * whose room turn takes it, so Scout is woken by none of it and has seen none
 * of it.
 */
const crew = Effect.gen(function* () {
  // Pip's room turn, the member it wakes, a routine's run and Scout's turn may run at once.
  yield* concurrentTurns(4);
  const scout = yield* member("Scout");
  const wren = yield* member("Wren");
  const pip = yield* member("Pip");
  const room = yield* roomWith(scout, [wren, pip]);
  const all = [scout, wren, pip];
  const toPip = (text: string) => operatorWrites(room.id, all, text, to(pip));
  return { scout, wren, pip, room, all, toPip };
});

const SideRow = Schema.Struct({ engine_session_id: SessionId, admitted_turn_id: TurnId });

/** The running turn of the routine's run, in its side session. */
const sideTurn = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SideRow,
      execute: (id) => sql`
        SELECT s.engine_session_id, s.admitted_turn_id FROM sessions s
        JOIN routine_runs r ON r.wake_id = s.side_wake_id
        WHERE r.routine_id = ${id} AND s.purpose = 'side' AND s.retired_at IS NULL
          AND s.engine_session_id IS NOT NULL AND s.admitted_turn_id IS NOT NULL
      `,
    });
    return yield* eventually(find(routineId).pipe(Effect.orDie));
  });

it.effect("reads a room it is in, newest last, by count or search, within one result", () =>
  Effect.gen(function* () {
    const { scout, wren, pip, room, toPip } = yield* crew;
    const theirs = yield* roomWith(wren, [pip]);
    yield* toPip("Draft the deck.");
    const pipTurn = yield* nextTurn(pip.bot.id);
    yield* say(pip, pipTurn, { text: "Deck draft is up.", mention: [wren.bot.id] });
    yield* toPip("Add the numbers.");
    const turnId = yield* operatorAsks(scout, "Where is the room at?");

    const all = readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    const order = ["Draft the deck.", "Deck draft is up.", "Add the numbers."].map((text) =>
      all.indexOf(text),
    );
    assert.deepStrictEqual(
      order.toSorted((a, b) => a - b),
      order,
    );
    assert.notInclude(order, -1);
    assert.include(all, `from="Pip"`);
    assert.notInclude(all, "earlier");

    const newest = readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, count: 1 }),
    );
    assert.include(newest, "Add the numbers.");
    assert.notInclude(newest, "Deck draft is up.");
    assert.include(newest, "2 earlier messages are not shown.");

    // A search folds case, and matches the text or the author's name.
    const deck = readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, search: "DECK" }),
    );
    assert.include(deck, "Draft the deck.");
    assert.include(deck, "Deck draft is up.");
    assert.notInclude(deck, "Add the numbers.");
    const byPip = readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, search: "pip" }),
    );
    assert.include(byPip, "Deck draft is up.");
    assert.notInclude(byPip, "Draft the deck.");

    // Two long messages do not fit one result: the newest goes, and the read says so.
    yield* toPip(`${"a".repeat(40_000)} first long`);
    yield* toPip(`${"b".repeat(40_000)} second long`);
    const long = readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    assert.include(long, "second long");
    assert.notInclude(long, "first long");
    assert.include(long, "Fewer messages are shown than you asked for");
    assert.include(long, "4 earlier messages are not shown.");

    // Only a room it is in, archived or not.
    assert.include(
      refusalOf(yield* call(scout.session, turnId, "read_room", { room: theirs.id })),
      "`list_teammates` shows the rooms you are in",
    );
    yield* archive(room.id, true);
    const archived = readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, count: 1 }),
    );
    assert.include(archived, `archived="true"`);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "posts from its own conversation at once on what it has seen, and otherwise shows what it missed",
  () =>
    Effect.gen(function* () {
      const { scout, pip, room, toPip } = yield* crew;
      const turnId = yield* operatorAsks(scout, "Ask Pip for the deck.");
      const deck = { to: room.id, text: "Pip, please make the deck.", mention: [pip.bot.id] };
      assert.strictEqual(
        statusOf(yield* call(scout.session, turnId, "message_bot", deck)),
        "posted",
      );
      yield* endTurn(scout, turnId);

      yield* toPip("Is the deck done?");
      const pipTurn = yield* nextTurn(pip.bot.id);
      yield* say(pip, pipTurn, { text: "The deck is done and delivered." });
      const next = yield* operatorAsks(scout, "The test is over: cancel the deck there.", turnId);
      const cancel = { to: room.id, text: "Stop the deck, cancel the work." };

      const refused = refusalOf(yield* call(scout.session, next, "message_bot", cancel));
      assert.include(refused, "Nothing was sent");
      assert.include(refused, "The deck is done and delivered.");
      assert.include(refused, "Is the deck done?");
      // What it posted itself is not news to it.
      assert.notInclude(refused, "Pip, please make the deck.");
      assert.notInclude(yield* roomTexts(room.id), cancel.text);

      // Sent again, it goes out: the refusal showed what it missed.
      assert.strictEqual(
        statusOf(yield* call(scout.session, next, "message_bot", cancel)),
        "posted",
      );
      assert.include(yield* roomTexts(room.id), cancel.text);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a post again when something newer arrived after it was refused", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("The deck is due Friday.");
    const turnId = yield* operatorAsks(scout, "Tell the room I am late.");
    const late = { to: room.id, text: "Our user will be late." };
    assert.include(
      refusalOf(yield* call(scout.session, turnId, "message_bot", late)),
      "The deck is due Friday.",
    );

    yield* toPip("Friday moved to Monday.");
    const again = refusalOf(yield* call(scout.session, turnId, "message_bot", late));
    assert.include(again, "Friday moved to Monday.");
    assert.notInclude(again, "The deck is due Friday.");

    assert.strictEqual(statusOf(yield* call(scout.session, turnId, "message_bot", late)), "posted");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("relays the operator's word only with a post that went out", () =>
  Effect.gen(function* () {
    const { scout, wren, pip, room, toPip } = yield* crew;
    yield* toPip("Work it out with Wren.");
    const pipTurn = yield* nextTurn(pip.bot.id);
    yield* say(pip, pipTurn, { text: "Wren, your half?", mention: [wren.bot.id] });

    const turnId = yield* operatorAsks(scout, "Ask Wren to wrap up in the group.");
    const wrap = { to: room.id, text: "Wren, please wrap up.", mention: [wren.bot.id] };
    refusalOf(yield* call(scout.session, turnId, "message_bot", wrap));

    // Sent again, it is still the turn's first post there: it carries the
    // operator's word, round 0, and wakes Wren.
    const posted = yield* call(scout.session, turnId, "message_bot", wrap);
    assert.strictEqual(statusOf(posted), "posted");
    assert.isFalse(wokeNobody(posted));
    assert.deepStrictEqual((yield* roundsIn(room.id)).at(-1), [wrap.text, 0]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("gives a reply the round of what its turn read of the room", () =>
  Effect.gen(function* () {
    const { scout, wren, pip, room, all } = yield* crew;
    yield* operatorWrites(room.id, all, "Scout and Pip, plan the launch.", to(scout, pip));
    const scoutTurn = yield* nextTurn(scout.bot.id);
    const pipTurn = yield* nextTurn(pip.bot.id);
    yield* say(pip, pipTurn, { text: "Wren, the dates?", mention: [wren.bot.id] });
    const wrenTurn = yield* nextTurn(wren.bot.id);
    yield* say(wren, wrenTurn, { text: "Launch on the 3rd." });

    // Its envelope showed the operator's word; the read shows round 2 as well.
    readOf(yield* call(scout.session, scoutTurn, "read_room", { room: room.id }));
    yield* say(scout, scoutTurn, { text: "Then I book the 3rd." });
    assert.deepStrictEqual((yield* roundsIn(room.id)).at(-1), ["Then I book the 3rd.", 3]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("never checks a post of the room's own turn", () =>
  Effect.gen(function* () {
    const { scout, room, all, toPip } = yield* crew;
    yield* operatorWrites(room.id, all, "Scout, take the summary.", to(scout));
    const roomTurn = yield* nextTurn(scout.bot.id);
    // Written while Scout's room turn runs: its envelope did not carry it.
    yield* toPip("Pip, take the numbers.");

    assert.strictEqual(
      statusOf(
        yield* call(scout.session, roomTurn, "message_bot", { to: room.id, text: "On it." }),
      ),
      "posted",
    );
    assert.strictEqual(
      statusOf(yield* say(scout, roomTurn, { text: "Summary coming." })),
      "recorded",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts a routine's read for its own run only, never for the main session", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("The deck is done.");
    const routine = yield* (yield* Routines).create({
      commandId: command(),
      botId: scout.bot.id,
      draft: {
        name: "Room check",
        instruction: "Check the room.",
        trigger: { _tag: "webhook" },
      },
      author: { _tag: "operator" },
    });
    yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
    const side = yield* sideTurn(routine.id);
    const update = { to: room.id, text: "The deck is checked." };

    readOf(
      yield* call(side.engine_session_id, side.admitted_turn_id, "read_room", { room: room.id }),
    );
    assert.strictEqual(
      statusOf(yield* call(side.engine_session_id, side.admitted_turn_id, "message_bot", update)),
      "posted",
    );

    const turnId = yield* operatorAsks(scout, "Post the deck status.");
    assert.include(
      refusalOf(yield* call(scout.session, turnId, "message_bot", update)),
      "The deck is done.",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("spares the next room envelope what a read in its own conversation showed", () =>
  Effect.gen(function* () {
    const { scout, room, all, toPip } = yield* crew;
    yield* toPip("Draft the deck.");
    const turnId = yield* operatorAsks(scout, "Where is the room at?");
    readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    yield* endTurn(scout, turnId);

    yield* operatorWrites(room.id, all, "Scout, your view?", to(scout));
    yield* nextTurn(scout.bot.id, turnId);
    const envelope = yield* lastEnvelope(scout);
    assert.include(envelope, "Scout, your view?");
    assert.notInclude(envelope, "Draft the deck.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

// A read of fewer messages than the session missed leaves the rest unseen.
it.effect("leaves the room unseen after a read that showed less than was missed", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("Cancel the vendor order.");
    yield* toPip("Lunch is at noon.");
    const turnId = yield* operatorAsks(scout, "Ask Pip to place the vendor order.");
    const read = readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, count: 1 }),
    );
    assert.include(read, "Lunch is at noon.");
    assert.notInclude(read, "Cancel the vendor order.");
    const order = { to: room.id, text: "Pip, please place the vendor order." };
    assert.include(
      refusalOf(yield* call(scout.session, turnId, "message_bot", order)),
      "Cancel the vendor order.",
    );

    // Read in full, the room is seen, and the post goes out.
    readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    assert.strictEqual(
      statusOf(yield* call(scout.session, turnId, "message_bot", order)),
      "posted",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

// A post written in the same model message as a read was written without what the read showed.
it.effect("does not count a read for a post written beside it", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("The deck is delivered.");
    const turnId = yield* operatorAsks(scout, "Cancel the deck in the room.");
    const read = { room: room.id };
    const cancel = { to: room.id, text: "Please cancel the deck." };
    yield* record(scout.session, turnId, "read_room", read);
    yield* record(scout.session, turnId, "message_bot", cancel);

    assert.include(
      readOf(yield* answer(scout.session, "read_room", read)),
      "The deck is delivered.",
    );
    assert.include(
      refusalOf(yield* answer(scout.session, "message_bot", cancel)),
      "The deck is delivered.",
    );
    // Written after it was shown, the same post goes out.
    assert.strictEqual(
      statusOf(yield* call(scout.session, turnId, "message_bot", cancel)),
      "posted",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

// What an earlier session read never reached the one that replaced it.
it.effect("gives a fresh session no view of a room an earlier one read", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("The deck is delivered.");
    const turnId = yield* operatorAsks(scout, "Where is the room at?");
    readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    yield* endTurn(scout, turnId);

    yield* (yield* Bots).freshStart({ commandId: command(), botId: scout.bot.id });
    yield* sendToBot(scout.bot.id, "Cancel the deck in the room.");
    const replacement = yield* sessionAfter(scout.bot.id, scout.session);
    const next = yield* nextTurn(scout.bot.id, turnId);
    assert.include(
      refusalOf(
        yield* call(replacement, next, "message_bot", { to: room.id, text: "Cancel the deck." }),
      ),
      "The deck is delivered.",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

// Its first room envelope shows a fresh session what only the one it replaced was shown.
it.effect("carries in a fresh session's first room envelope what an earlier one read", () =>
  Effect.gen(function* () {
    const { scout, room, all, toPip } = yield* crew;
    yield* toPip("The deck is delivered.");
    const turnId = yield* operatorAsks(scout, "Where is the room at?");
    readOf(yield* call(scout.session, turnId, "read_room", { room: room.id }));
    yield* endTurn(scout, turnId);

    yield* (yield* Bots).freshStart({ commandId: command(), botId: scout.bot.id });
    yield* operatorWrites(room.id, all, "Scout, your view?", to(scout));
    const replacement = yield* sessionAfter(scout.bot.id, scout.session);
    yield* nextTurn(scout.bot.id, turnId);
    const envelope = yield* lastEnvelope({ ...scout, session: replacement });
    assert.include(envelope, "Scout, your view?");
    assert.include(envelope, "The deck is delivered.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

// A room post refused for what it missed is not the chain's stop, which its user still hears of.
it.effect("tells its user a chain stopped also after a room post was refused", () =>
  Effect.gen(function* () {
    yield* chainLimits({ hops: 1, fanOut: 1 });
    const { scout, wren, room, toPip } = yield* crew;
    yield* toPip("The deck is delivered.");
    const wrenTurn = yield* operatorAsks(wren, "Ask Scout about the deck.");
    yield* messageTeammate(wren.session, wrenTurn, {
      to: scout.bot.id,
      text: "Is the deck done?",
      urgent: true,
    });
    const scoutTurn = yield* nextTurn(scout.bot.id);
    refusalOf(
      yield* call(scout.session, scoutTurn, "message_bot", { to: room.id, text: "Deck done?" }),
    );
    refusalOf(
      yield* call(scout.session, scoutTurn, "message_bot", {
        to: wren.bot.id,
        text: "Yes, it is delivered.",
        urgent: true,
      }),
    );
    assert.deepStrictEqual(yield* noticesOf(scout.bot.id), ["chain-stopped"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

// A search reads a selection, so it leaves the room unseen for what comes next.
it.effect("leaves the room unseen after a search", () =>
  Effect.gen(function* () {
    const { scout, room, toPip } = yield* crew;
    yield* toPip("The deck is done.");
    const turnId = yield* operatorAsks(scout, "Post the deck status.");
    readOf(
      yield* call(scout.session, turnId, "read_room", { room: room.id, search: "nothing like it" }),
    );
    assert.include(
      refusalOf(
        yield* call(scout.session, turnId, "message_bot", { to: room.id, text: "Deck status?" }),
      ),
      "The deck is done.",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);
