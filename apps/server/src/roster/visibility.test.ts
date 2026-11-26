// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type Bot, BotId, RoomId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Bots } from "../bots/Bots.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import { finish, lastEnvelope, type Member, member, say } from "../testing/rooms.ts";
import {
  command,
  concurrentTurns,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotTools } from "../tools/BotTools.ts";

// Bots and rooms are visible or hidden (decision 0050): the operator sets it,
// and so does a bot, for what it made, or as the primary bot, for anything
// but itself, unless the operator chose.

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
      requestId: `visibility-call-${++calls}`,
      sessionId,
      tool,
      arguments: args,
    });
  });

/** `set_visibility`, which acts for no turn, from any session of the bot. */
const setVisibility = (
  sessionId: SessionId,
  id: string,
  hidden: boolean,
  requestId = `visibility-call-${++calls}`,
) =>
  Effect.gen(function* () {
    return yield* (yield* BotTools).call({
      requestId,
      sessionId,
      tool: "set_visibility",
      arguments: { id, hidden },
    });
  });

const decodeMade = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));
const decodeShown = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, hidden: Schema.Boolean }),
);

const resultOf = (response: ToolCallResponse) =>
  response._tag === "result"
    ? response.value
    : assert.fail(`expected a result, got ${JSON.stringify(response)}`);

const refusalOf = (response: ToolCallResponse) =>
  response._tag === "refused"
    ? response.message
    : assert.fail(`expected a refusal, got ${JSON.stringify(response)}`);

const hiddenNow = (response: ToolCallResponse) => decodeShown(resultOf(response)).hidden;

const storedBot = (id: BotId) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* BotStore).find(id)).bot;
  });

const botHidden = (id: BotId) => Effect.map(storedBot(id), (bot) => bot.hidden);

const roomHidden = (id: RoomId) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* Rooms).find(id)).hidden;
  });

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

/** The bot's turn answering the operator, and its engine session. */
const operatorAsks = (bot: Bot, text: string) =>
  Effect.gen(function* () {
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, text);
    return { session, turnId: yield* nextTurn(bot.id) };
  });

it.effect("makes a hidden helper and a hidden room, which still work", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Get the launch notes written.");

    const made = decodeMade(
      resultOf(
        yield* call(session, turnId, "create_bot", {
          name: "Quill",
          job: "Drafts notes.",
          hidden: true,
        }),
      ),
    );
    const quill = BotId.make(made.id);
    const started = decodeMade(
      resultOf(
        yield* call(session, turnId, "start_room", {
          name: "Notes desk",
          members: [quill],
          kickoff: "Quill drafts the notes, I review them.",
          hidden: true,
        }),
      ),
    );
    const roomId = RoomId.make(started.id);

    assert.isTrue(yield* botHidden(quill));
    assert.isTrue(yield* roomHidden(roomId));
    // Hidden from the list, not from the work: the kickoff reaches the helper.
    const caller: Member = { bot: scout, session };
    const helper: Member = { bot: yield* storedBot(quill), session: yield* engineSession(quill) };
    yield* say(caller, turnId, { text: "Quill is on the notes.", done: true });
    yield* finish(caller, turnId, [caller, helper]);
    yield* nextTurn(quill);
    assert.include(yield* lastEnvelope(helper), "Quill drafts the notes");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "lets a bot change what it made and the primary bot anything but itself, never more",
  () =>
    Effect.gen(function* () {
      yield* concurrentTurns(4);
      const scout = yield* primaryBot("Scout");
      const wren = yield* member("Wren");
      const pip = yield* member("Pip");
      const { session, turnId } = yield* operatorAsks(wren.bot, "Start a room with Pip.");
      const started = decodeMade(
        resultOf(
          yield* call(session, turnId, "start_room", {
            name: "Pairing",
            members: [pip.bot.id],
            kickoff: "Pip, let's pair on the parser.",
          }),
        ),
      );
      const scouting = yield* operatorAsks(scout, "Make me a bot for invoices.");
      const made = decodeMade(
        resultOf(
          yield* call(scouting.session, scouting.turnId, "create_bot", {
            name: "Ledger",
            job: "Keeps invoices.",
          }),
        ),
      );

      // Wren started the room: it may hide it and show it again.
      assert.isTrue(hiddenNow(yield* setVisibility(wren.session, started.id, true)));
      assert.isTrue(yield* roomHidden(RoomId.make(started.id)));
      assert.isFalse(hiddenNow(yield* setVisibility(wren.session, started.id, false)));
      // Not what another bot made.
      assert.include(
        refusalOf(yield* setVisibility(wren.session, made.id, true)),
        "only the bots and rooms you made",
      );
      assert.isFalse(yield* botHidden(BotId.make(made.id)));
      // The primary bot may change what any bot made.
      assert.isTrue(hiddenNow(yield* setVisibility(scouting.session, started.id, true)));
      assert.isTrue(hiddenNow(yield* setVisibility(scouting.session, made.id, true)));
      // No bot hides the primary bot, the primary bot itself included.
      for (const caller of [scouting.session, wren.session]) {
        assert.include(refusalOf(yield* setVisibility(caller, scout.id, true)), "primary bot");
      }
      assert.isFalse(yield* botHidden(scout.id));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps every bot from changing what the operator made, showed or hid", () =>
  Effect.gen(function* () {
    yield* concurrentTurns(4);
    const scout = yield* primaryBot("Scout");
    const wren = yield* member("Wren");
    const pip = yield* member("Pip");
    const { session, turnId } = yield* operatorAsks(scout, "Make a helper and a room for it.");
    const made = decodeMade(
      resultOf(
        yield* call(session, turnId, "create_bot", { name: "Ledger", job: "Keeps invoices." }),
      ),
    );
    const ledger = BotId.make(made.id);
    const started = decodeMade(
      resultOf(
        yield* call(session, turnId, "start_room", {
          name: "Books",
          members: [ledger],
          kickoff: "Ledger, keep the books.",
          hidden: true,
        }),
      ),
    );
    const books = RoomId.make(started.id);
    const operatorRoom = yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [wren.bot.id, pip.bot.id],
    });

    // The operator shows the room and hides the helper.
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: books,
      changes: { hidden: false },
    });
    yield* (yield* Bots).update({ commandId: command(), botId: ledger, changes: { hidden: true } });

    const operatorChose = "your user chose";
    assert.include(refusalOf(yield* setVisibility(session, books, true)), operatorChose);
    assert.include(refusalOf(yield* setVisibility(session, ledger, false)), operatorChose);
    // What the operator made is theirs from the start, visible as they made it.
    assert.include(refusalOf(yield* setVisibility(session, wren.bot.id, true)), operatorChose);
    assert.include(refusalOf(yield* setVisibility(session, operatorRoom.id, true)), operatorChose);
    assert.isFalse(yield* roomHidden(books));
    assert.isTrue(yield* botHidden(ledger));
    assert.isFalse(yield* botHidden(wren.bot.id));
    assert.isFalse(yield* roomHidden(operatorRoom.id));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers a retried call as it first did, the bot it hid deleted meanwhile", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Make me a bot for invoices.");
    const made = decodeMade(
      resultOf(
        yield* call(session, turnId, "create_bot", { name: "Ledger", job: "Keeps invoices." }),
      ),
    );
    assert.isTrue(hiddenNow(yield* setVisibility(session, made.id, true, "hide-ledger")));
    yield* (yield* Bots).remove({
      commandId: command(),
      botId: BotId.make(made.id),
      deleteFiles: false,
    });
    // The bridge forwards the request again: its id no longer names a bot.
    assert.isTrue(hiddenNow(yield* setVisibility(session, made.id, true, "hide-ledger")));
  }).pipe(Effect.provide(TestDomain.layer)),
);
