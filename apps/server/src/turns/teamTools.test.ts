// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type ModelChoice,
  type Notice,
  ROOM_QUIET_ROUND,
  RoomId,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { ROOM_CLOSING_NOTE, ROOM_NEWCOMER_LINE } from "@j3-bots/prompts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Entries } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  archive,
  finish,
  lastEnvelope,
  type Member,
  member,
  noticesIn,
  operatorWrites,
  roomEntries,
  roomWakeStatuses,
  roomWith,
  running,
  sawText,
  say,
  stopRoom,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  answerFirstOption,
  askRegion,
  awaitEntry,
  command,
  concurrentTurns,
  conversation,
  createBot,
  engineSession,
  eventually,
  flushed,
  holdGate,
  messageTeammate,
  nextTurn,
  providerIs,
  received,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Cards } from "./Cards.ts";
import { newcomer } from "./firstContact.ts";
import { Pipeline } from "./Pipeline.ts";
import { Stops } from "./Stops.ts";

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
const decodeNote = Schema.decodeUnknownSync(Schema.Struct({ note: Schema.String }));

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
const primaryBot = (name: string, model?: ModelChoice) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name, model);
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

it.effect(
  "makes a bot on its maker's model, and on the default while that provider is not ready",
  () =>
    Effect.gen(function* () {
      const scout = yield* primaryBot("Scout", TestDomain.OTHER_PROVIDER_MODEL);
      const { session, turnId } = yield* operatorAsks(scout, "Make me two bots for the shop.");
      const store = yield* BotStore;
      const modelOf = (id: BotId) =>
        Effect.map(store.find(id), (found) => Option.getOrThrow(found).bot.model);

      const ledger = decodeCreated(resultOf(yield* createIn(session, turnId, "Ledger")));
      assert.deepStrictEqual(yield* modelOf(ledger.id), TestDomain.OTHER_PROVIDER_MODEL);

      yield* providerIs(TestDomain.OTHER_PROVIDER_MODEL.providerId, {
        _tag: "sign-in-required",
        command: "connect",
      });
      const mole = decodeCreated(resultOf(yield* createIn(session, turnId, "Mole")));
      assert.deepStrictEqual(yield* modelOf(mole.id), TestDomain.DEFAULT_MODEL);
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

it.effect("makes no bot and starts no room once a Stop covers the turn, before it ends", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Make me a deploy group.");
    const pip = decodeCreated(resultOf(yield* createIn(session, turnId, "Pip")));
    // The Stop is recorded; its round has not reached the engine, so the
    // turn still runs and its calls still match.
    const gate = yield* holdGate(scout.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: scout.id });

    const created = yield* createIn(session, turnId, "Ledger");
    const started = yield* call(session, turnId, "start_room", {
      name: "Deploy",
      members: [pip.id],
      kickoff: "Pip deploys.",
      with_user: true,
    });

    assert.include(refusalOf(created), "Your user stopped this work");
    assert.include(refusalOf(started), "Your user stopped this work");
    yield* gate.release;
    const names = (yield* (yield* BotStore).list).map(({ bot }) => bot.profile.name);
    assert.deepStrictEqual(names.toSorted(), ["Pip", "Scout"]);
    assert.deepStrictEqual(yield* (yield* Rooms).list, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates no bot on the operator's message steered into a turn it did not open", () =>
  Effect.gen(function* () {
    const scout = yield* primaryBot("Scout");
    const wren = yield* createBot("Wren");
    const asked = yield* operatorAsks(wren, "Ask Scout what is left.");
    yield* messageTeammate(asked.session, asked.turnId, {
      to: scout.id,
      text: "What is left?",
      urgent: true,
    });
    yield* endTurn(wren.id, asked.session, asked.turnId);
    const teammateTurn = yield* nextTurn(scout.id);
    // The operator writes while that turn runs, and the engine steers it in:
    // whether the agent took it is known only once the turn has ended.
    yield* sendToBot(scout.id, "Make me a bot for invoices.");
    yield* flushed(scout.id);

    const reply = yield* createIn(yield* engineSession(scout.id), teammateTurn, "Ledger");

    assert.include(refusalOf(reply), "while this turn was running does not count");
    const names = (yield* (yield* BotStore).list).map(({ bot }) => bot.profile.name);
    assert.deepStrictEqual(names.toSorted(), ["Scout", "Wren"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "creates no bot in the turn a dismissed card starts, and does in one an answer starts",
  () =>
    Effect.gen(function* () {
      const scout = yield* primaryBot("Scout");
      const { session, turnId } = yield* operatorAsks(scout, "Set up the deploy.");
      const first = yield* askRegion(scout.id, session, turnId);
      yield* endTurn(scout.id, session, turnId);
      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: first.id,
        answer: { _tag: "dismiss" },
      });
      const dismissed = yield* nextTurn(scout.id, turnId);

      const refused = yield* createIn(session, dismissed, "Ledger");

      assert.include(refusalOf(refused), "only your user can ask for a new bot");
      const second = yield* askRegion(scout.id, session, dismissed);
      yield* endTurn(scout.id, session, dismissed);
      yield* answerFirstOption(second);
      const answered = yield* nextTurn(scout.id, dismissed);
      resultOf(yield* createIn(session, answered, "Ledger"));
      const names = (yield* (yield* BotStore).list).map(({ bot }) => bot.profile.name);
      assert.deepStrictEqual(names.toSorted(), ["Ledger", "Scout"]);
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

it.effect("goes on from the bots a failed turn made when the operator retries it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const scout = yield* primaryBot("Scout");
    const { session, turnId } = yield* operatorAsks(scout, "Make me a support group.");
    const pip = yield* madeMember(session, turnId, "Pip");
    for (const name of ["Two", "Three", "Four"]) resultOf(yield* createIn(session, turnId, name));
    yield* control.finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    const failed = yield* awaitEntry(scout.id, "notice");
    assert.deepStrictEqual(failed.notice, { _tag: "turn-failed", failure: "provider-error" });

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: failed.id });
    const retried = yield* nextTurn(scout.id, turnId);
    const now = yield* engineSession(scout.id);

    // The request has made four: one more, not a second set.
    resultOf(yield* createIn(now, retried, "Five"));
    assert.include(refusalOf(yield* createIn(now, retried, "Six")), "at most 5 bots");
    // The room it starts finds the bot made before the retry as made for it.
    const started = yield* call(now, retried, "start_room", {
      name: "Support",
      members: [pip.bot.id],
      kickoff: "Pip, you take billing.",
      with_user: true,
    });
    const roomId = decodeStarted(resultOf(started)).id;
    assert.deepStrictEqual(yield* noticesOf(pip.bot.id), [
      { _tag: "made-for-room", botId: scout.id, roomId },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("goes on from the bots a failed room turn made when the operator retries it there", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const scoutBot = yield* primaryBot("Scout");
    const scout = { bot: scoutBot, session: yield* engineSession(scoutBot.id) } satisfies Member;
    const wren = yield* member("Wren");
    const room = yield* roomWith(scout, [wren]);
    // The operator asks in the room: a `room` wake, and so is its Retry.
    yield* operatorWrites(room.id, [scout, wren], "Make me a support group.", to(scout));
    const turnId = yield* nextTurn(scout.bot.id);
    const pip = yield* madeMember(scout.session, turnId, "Pip");
    for (const name of ["Two", "Three", "Four"]) {
      resultOf(yield* createIn(scout.session, turnId, name));
    }
    yield* control.finishTurn({
      sessionId: scout.session,
      turnId,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    yield* turnEnded(scout.bot.id);
    yield* until(
      Effect.map(roomEntries(room.id), (entries) =>
        entries.some((entry) => entry._tag === "notice" && entry.retryable),
      ),
    );
    const failed = (yield* roomEntries(room.id)).find(
      (entry) => entry._tag === "notice" && entry.retryable,
    );
    assert.isDefined(failed);

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: failed.id });
    const retried = yield* nextTurn(scout.bot.id, turnId);
    const now = yield* engineSession(scout.bot.id);

    // The request has made four: one more, not a second set.
    resultOf(yield* createIn(now, retried, "Five"));
    assert.include(refusalOf(yield* createIn(now, retried, "Six")), "at most 5 bots");
    const started = yield* call(now, retried, "start_room", {
      name: "Support",
      members: [pip.bot.id],
      kickoff: "Pip, you take billing.",
      with_user: true,
    });
    const roomId = decodeStarted(resultOf(started)).id;
    assert.deepStrictEqual(yield* noticesOf(pip.bot.id), [
      { _tag: "made-for-room", botId: scout.bot.id, roomId },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "starts a room whose kickoff every other member reads at once, the bots made for it with no hello",
  () =>
    Effect.gen(function* () {
      // A turn slot for each member.
      yield* concurrentTurns(4);
      const scout = yield* primaryBot("Scout");
      const wren = yield* member("Wren");
      const { session, turnId } = yield* operatorAsks(scout, "Make me a support group.");
      const pip = yield* madeMember(session, turnId, "Pip");
      const mole = yield* madeMember(session, turnId, "Mole");
      const caller: Member = { bot: scout, session };
      const team = [caller, pip, mole, wren];

      const started = yield* call(session, turnId, "start_room", {
        name: "Support",
        members: [pip.bot.id, mole.bot.id, wren.bot.id],
        kickoff: "Pip takes billing, Mole takes setup, Wren reviews. Pip opens.",
        with_user: true,
      });

      const roomId = decodeStarted(resultOf(started)).id;
      const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
      assert.deepStrictEqual(
        room.members,
        team.map((one) => one.bot.id),
      );
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
      yield* say(caller, turnId, { text: "Pip, Mole and Wren are on it in Support.", done: true });
      yield* finish(caller, turnId, team);
      // The other members read the kickoff at once, and Pip opens, as it asks.
      const kicked = [
        [pip, yield* nextTurn(pip.bot.id)],
        [mole, yield* nextTurn(mole.bot.id)],
        [wren, yield* nextTurn(wren.bot.id)],
      ] as const;
      assert.deepStrictEqual(yield* running(team), ["Pip", "Mole", "Wren"]);
      for (const [one, turn] of kicked) {
        const envelope = yield* lastEnvelope(one);
        assert.include(envelope, "Pip takes billing");
        // It reads as the kickoff, which names its part, not as any message that mentions it.
        assert.include(envelope, 'reason="kickoff"');
        // A bot made for the room meets the operator here, and opens with who it is.
        assert.strictEqual(envelope.includes(ROOM_NEWCOMER_LINE), one !== wren);
        if (one === pip) yield* say(one, turn, { text: "On it.", done: true });
      }
      for (const [one, turn] of kicked) yield* finish(one, turn, team);
      // Pip's reply mentions nobody: Scout, Mole and Wren read it after, as a
      // member's message.
      for (const [one, previous] of [
        [caller, turnId],
        [mole, kicked[1][1]],
        [wren, kicked[2][1]],
      ] as const) {
        const reply = yield* nextTurn(one.bot.id, previous);
        const envelope = yield* lastEnvelope(one);
        assert.include(envelope, "On it.");
        assert.include(envelope, 'reason="member"');
        // Mole has not spoken yet: still new to the operator.
        assert.strictEqual(envelope.includes(ROOM_NEWCOMER_LINE), one === mole);
        yield* finish(one, reply, team);
      }
      assert.deepStrictEqual(yield* running(team), []);
      for (const made of [pip, mole]) {
        assert.deepStrictEqual(yield* hellos(made.bot.id), ["cancelled"]);
      }
      // Their first turn was the room's: nothing came to their own conversations.
      assert.deepStrictEqual(yield* roomWakeStatuses(pip.bot.id, roomId), ["finished"]);
      assert.deepStrictEqual(yield* roomWakeStatuses(mole.bot.id, roomId), [
        "finished",
        "finished",
      ]);
      // Pip has met the operator, which it does not forget once it leaves the
      // room it spoke in; Mole still has not.
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId,
        changes: { members: [scout.id, mole.bot.id, wren.bot.id] },
      });
      const isNewcomer = newcomer(yield* SqlClient.SqlClient);
      assert.isFalse(yield* isNewcomer(pip.bot.id));
      assert.isTrue(yield* isNewcomer(mole.bot.id));
      // Any message of Mole's in the room counts, as its engine's own text
      // does, and the room's deletion takes none of it back.
      yield* (yield* Entries).append({
        target: { _tag: "room", roomId },
        entry: {
          _tag: "message",
          author: { _tag: "bot", botId: mole.bot.id },
          text: "Billing is clear.",
          attachments: [],
          mentions: { _tag: "bots", ids: [] },
          delivery: { _tag: "delivered" },
          commandId: null,
        },
      });
      yield* (yield* Rooms).remove({ commandId: command(), roomId });
      assert.isFalse(yield* isNewcomer(pip.bot.id));
      assert.isFalse(yield* isNewcomer(mole.bot.id));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "lets every member's answer to a kickoff reach the others, and the room go quiet on its own",
  () =>
    Effect.gen(function* () {
      const scout = yield* primaryBot("Scout");
      const [pip, mole, wren] = [
        yield* member("Pip"),
        yield* member("Mole"),
        yield* member("Wren"),
      ];
      const { session, turnId } = yield* operatorAsks(scout, "Make me a launch group.");
      const caller: Member = { bot: scout, session };
      const team = [caller, pip, mole, wren];
      const roomId = decodeStarted(
        resultOf(
          yield* call(session, turnId, "start_room", {
            name: "Launch",
            members: [pip.bot.id, mole.bot.id, wren.bot.id],
            kickoff: "Each of you says what you take on.",
            with_user: true,
          }),
        ),
      ).id;
      yield* finish(caller, turnId, team);

      // Each member answers once; a turn after its answer ends without a word.
      const answered = new Set<Member>();
      const ran: Array<string> = [];
      while (true) {
        const next = yield* eventually(
          Effect.gen(function* () {
            for (const one of team) {
              const admitted = yield* admittedTurn(one.bot.id);
              if (Option.isSome(admitted) && !(one === caller && admitted.value === turnId)) {
                return Option.some(Option.some({ one, turn: admitted.value }));
              }
            }
            return (yield* running(team)).length === 0 &&
              !(yield* roomWakeStatuses(scout.id, roomId)).includes("pending") &&
              (yield* Effect.forEach([pip, mole, wren], (one) =>
                roomWakeStatuses(one.bot.id, roomId),
              )).every((statuses) => !statuses.includes("pending"))
              ? Option.some(Option.none())
              : Option.none();
          }),
        );
        if (Option.isNone(next)) break;
        const { one, turn } = next.value;
        ran.push(one.bot.profile.name);
        assert.isAtMost(ran.length, 12, `the room never went quiet: ${ran.join(", ")}`);
        if (one !== caller && !answered.has(one)) {
          answered.add(one);
          yield* say(one, turn, { text: `${one.bot.profile.name} takes a part.`, done: true });
        }
        yield* finish(one, turn, team);
      }

      // Every answer was posted and woke the others, far below the room's limit.
      assert.deepStrictEqual(
        (yield* roomEntries(roomId)).flatMap((entry) =>
          entry._tag === "message" && entry.author._tag === "bot" ? [entry.text] : [],
        ),
        [
          "Each of you says what you take on.",
          "Pip takes a part.",
          "Mole takes a part.",
          "Wren takes a part.",
        ],
      );
      assert.deepStrictEqual(
        (yield* noticesIn(roomId)).filter((notice) => notice._tag === "chain-stopped"),
        [],
      );
      for (const one of team) {
        for (const other of [pip, mole, wren].filter((answering) => answering !== one)) {
          assert.isTrue(
            yield* sawText(one, `${other.bot.profile.name} takes a part.`),
            `${one.bot.profile.name} never read ${other.bot.profile.name}'s answer`,
          );
        }
      }
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "puts a kickoff member's question in its own conversation, the room showing only where it waits",
  () =>
    Effect.gen(function* () {
      const scout = yield* primaryBot("Scout");
      const { session, turnId } = yield* operatorAsks(scout, "Make me a deploy group.");
      const pip = yield* madeMember(session, turnId, "Pip");
      const caller: Member = { bot: scout, session };
      const roomId = decodeStarted(
        resultOf(
          yield* call(session, turnId, "start_room", {
            name: "Deploy",
            members: [pip.bot.id],
            kickoff: "Pip deploys.",
            with_user: true,
          }),
        ),
      ).id;
      yield* say(caller, turnId, { text: "Pip is on it in Deploy.", done: true });
      yield* finish(caller, turnId, [caller, pip]);
      const turn = yield* nextTurn(pip.bot.id);

      const asked = yield* call(pip.session, turn, "ask", {
        prompt: "Which region?",
        options: [{ label: "Europe", value: "eu-west-1" }],
      });

      assert.strictEqual(decodeStatus(resultOf(asked)).status, "asked");
      const own = yield* conversation(pip.bot.id);
      assert.deepStrictEqual(
        own.map((entry) => entry._tag),
        ["notice", "question"],
      );
      const inRoom = yield* roomEntries(roomId);
      assert.isFalse(inRoom.some((entry) => entry._tag === "question"));
      assert.deepStrictEqual(yield* noticesIn(roomId), [
        { _tag: "room-started", botId: scout.id, roomId },
        { _tag: "waiting-in-conversation", botId: pip.bot.id },
      ]);
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
      with_user: true,
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
      with_user: true,
    });
    const outside = yield* call(session, turnId, "start_room", {
      name: "Pair",
      members: [wren.id],
      kickoff: "Hi.",
      with_user: true,
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

    // `urgent: false` says nothing a room post needs: it is taken as absent.
    const posted = yield* call(session, turnId, "message_bot", {
      to: room.id,
      text: "Wren, the release notes are yours.",
      mention: [wren.bot.id],
      urgent: false,
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

/** Whether a room post went in quiet: it is in the room, and the tool says it woke nobody. */
const wokeNobody = (response: ToolCallResponse) =>
  Schema.is(Schema.Struct({ stopped: Schema.Literal("room") }))(resultOf(response));

it.effect(
  "gives a room post from a turn of that room the round it was shown, and one from a turn nobody asked for the round past the room's newest",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      const room = yield* roomWith(scout, [wren]);

      // The room's own turn answers the operator's message there: every post
      // of it is round 1, however many it makes.
      yield* operatorWrites(room.id, [scout, wren], "Scout, gather the options.", to(scout));
      const roomTurn = yield* nextTurn(scout.bot.id);
      for (let n = 1; n <= ROOM_QUIET_ROUND + 1; n++) {
        const posted = yield* call(scout.session, roomTurn, "message_bot", {
          to: room.id,
          text: `Wren, option ${n}?`,
          mention: [wren.bot.id],
        });
        assert.isFalse(wokeNobody(posted));
      }
      yield* endTurn(scout.bot.id, scout.session, roomTurn);

      // A turn of Scout's own conversation nobody asked for brings no word,
      // and was shown nothing of the room: each post is a round past its
      // newest, until one is past the quiet round.
      const own = yield* control.startEngineTurn(scout.session);
      yield* nextTurn(scout.bot.id, roomTurn);
      for (let round = 2; round <= ROOM_QUIET_ROUND; round++) {
        const posted = yield* call(scout.session, own, "message_bot", {
          to: room.id,
          text: `Wren, round ${round}?`,
          mention: [wren.bot.id],
        });
        assert.isFalse(wokeNobody(posted));
      }
      const unasked = yield* call(scout.session, own, "message_bot", {
        to: room.id,
        text: "Wren, still there?",
        mention: [wren.bot.id],
      });
      assert.isTrue(wokeNobody(unasked));
      // A message of the operator's steered into such a turn is not their
      // word in it, so the bot is told to have them ask again.
      assert.include(decodeNote(resultOf(unasked)).note, "ask again once you have finished");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "reopens a quiet room for a post the operator asked for in the bot's own conversation",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      const pip = yield* member("Pip");
      const room = yield* roomWith(scout, [wren, pip]);

      // The room goes quiet on Scout's posts to Pip, from a turn of its own
      // conversation that nobody asked for: each is a round past the last.
      const unasked = yield* control.startEngineTurn(scout.session);
      yield* nextTurn(scout.bot.id);
      for (let n = 1; n <= ROOM_QUIET_ROUND; n++) {
        yield* call(scout.session, unasked, "message_bot", {
          to: room.id,
          text: `Pip, note ${n}.`,
          mention: [pip.bot.id],
        });
      }
      const quiet = yield* call(scout.session, unasked, "message_bot", {
        to: room.id,
        text: "Pip, the last note.",
        mention: [pip.bot.id],
      });
      assert.isTrue(wokeNobody(quiet));
      yield* endTurn(scout.bot.id, scout.session, unasked);

      // In Scout's own conversation, the operator asks for the room's work:
      // the post carries their word, so it wakes Wren and the room's rounds
      // start again.
      const { session, turnId } = yield* operatorAsks(scout.bot, "Start the test in the group.");
      const posted = yield* call(session, turnId, "message_bot", {
        to: room.id,
        text: "Wren, run the test now.",
        mention: [wren.bot.id],
      });
      assert.isFalse(wokeNobody(posted));
      assert.strictEqual(decodeStatus(resultOf(posted)).status, "posted");
      yield* say(scout, turnId, { text: "The test has started in the room.", done: true });
      yield* endTurn(scout.bot.id, session, turnId);

      yield* flushed(wren.bot.id);
      yield* nextTurn(wren.bot.id);
      const envelope = yield* lastEnvelope(wren);
      assert.include(envelope, "Wren, run the test now.");
      assert.include(envelope, "You were addressed");
      assert.notInclude(envelope, ROOM_CLOSING_NOTE);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "relays the operator's word to a room once a turn, the turn's later posts there taking rounds",
  () =>
    Effect.gen(function* () {
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      const room = yield* roomWith(scout, [wren]);
      const { session, turnId } = yield* operatorAsks(scout.bot, "Keep the group posted.");

      // The first post carries the operator's word, round 0; the turn's next
      // ones are Scout's own, each a round past the room's newest, so the
      // room goes quiet as it would after their message.
      for (let n = 0; n <= ROOM_QUIET_ROUND; n++) {
        const posted = yield* call(session, turnId, "message_bot", {
          to: room.id,
          text: `Update ${n}.`,
          mention: [wren.bot.id],
        });
        assert.isFalse(wokeNobody(posted));
      }
      const past = yield* call(session, turnId, "message_bot", {
        to: room.id,
        text: "One update too many.",
        mention: [wren.bot.id],
      });
      assert.isTrue(wokeNobody(past));
      // The operator's word was counted: the bot is not told to have them ask again.
      assert.notInclude(decodeNote(resultOf(past)).note, "ask again");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("posts nothing in a room the operator stopped from a turn begun before the Stop", () =>
  Effect.gen(function* () {
    const scout = yield* member("Scout");
    const wren = yield* member("Wren");
    const room = yield* roomWith(scout, [wren]);
    // Scout works in its own conversation, which the room's Stop does not end.
    const { session, turnId } = yield* operatorAsks(scout.bot, "Get Wren on the release notes.");
    yield* stopRoom(room.id);

    const posted = yield* call(session, turnId, "message_bot", {
      to: room.id,
      text: "Wren, the release notes are yours.",
      mention: [wren.bot.id],
    });

    assert.include(refusalOf(posted), "Your user stopped this work");
    assert.deepStrictEqual(yield* roomEntries(room.id), []);
    assert.deepStrictEqual(yield* roomWakeStatuses(wren.bot.id, room.id), []);
    // A turn begun after the Stop is new work, and posts.
    yield* say(scout, turnId, { text: "The room was stopped.", done: true });
    yield* endTurn(scout.bot.id, session, turnId);
    const next = yield* operatorAsks(scout.bot, "Now get Wren on them.");
    const again = yield* call(next.session, next.turnId, "message_bot", {
      to: room.id,
      text: "Wren, the release notes are yours.",
      mention: [wren.bot.id],
    });
    assert.strictEqual(decodeStatus(resultOf(again)).status, "posted");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "posts nothing in a room the operator stopped from a turn the engine began before it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const scout = yield* member("Scout");
      const wren = yield* member("Wren");
      const room = yield* roomWith(scout, [wren]);
      // The engine starts a turn of Scout's own conversation on its own: no
      // dispatch began it.
      const turnId = yield* control.startEngineTurn(scout.session);
      yield* nextTurn(scout.bot.id);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* stopRoom(room.id);

      const posted = yield* call(scout.session, turnId, "message_bot", {
        to: room.id,
        text: "Wren, the release notes are yours.",
        mention: [wren.bot.id],
      });

      assert.include(refusalOf(posted), "Your user stopped this work");
      assert.deepStrictEqual(yield* roomEntries(room.id), []);
      assert.deepStrictEqual(yield* roomWakeStatuses(wren.bot.id, room.id), []);
      // A turn the engine begins after the Stop is new work, and posts.
      yield* endTurn(scout.bot.id, scout.session, turnId);
      const next = yield* control.startEngineTurn(scout.session);
      yield* nextTurn(scout.bot.id, turnId);
      const again = yield* call(scout.session, next, "message_bot", {
        to: room.id,
        text: "The release notes are next.",
      });
      assert.strictEqual(decodeStatus(resultOf(again)).status, "posted");
      const [message] = yield* roomEntries(room.id);
      assert.strictEqual(
        message?._tag === "message" ? message.text : null,
        "The release notes are next.",
      );
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
