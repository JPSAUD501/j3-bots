// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  ROOM_CLOSING_ROUND,
  ROOM_QUIET_ROUND,
  type RoutineId,
} from "@j3-bots/contracts";
import { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { ROOM_CLOSING_NOTE } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Routines } from "../routines/Routines.ts";
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
  roomWith,
  roundsIn,
  running,
  say,
  to,
} from "../testing/rooms.ts";
import { command, concurrentTurns, eventually, nextTurn, sendToBot } from "../testing/turns.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotTools } from "../tools/BotTools.ts";

/** Whether the room was quiet: the message is posted, and the tool says it woke nobody. */
const wokeNobody = (response: ToolCallResponse) =>
  response._tag === "result" &&
  Schema.is(Schema.Struct({ stopped: Schema.Literal("room") }))(response.value);

/** What one round of a room where every member answers everything looked like. */
interface Wave {
  /** Whether each member's envelope said the conversation is closing. */
  readonly closing: ReadonlyArray<boolean>;
  /** Whether each member's message woke nobody. */
  readonly quiet: ReadonlyArray<boolean>;
}

/**
 * Every member answers every message, to the whole room, until the room is
 * quiet: each wave, every member's turn reads what the others said in the
 * wave before and answers it, and only then do the turns end.
 */
const everyoneAnswers = (members: ReadonlyArray<Member>) =>
  Effect.gen(function* () {
    const waves: Array<Wave> = [];
    let turns: ReadonlyArray<readonly [Member, TurnId]> = [];
    while (waves.length <= ROOM_QUIET_ROUND) {
      const previous = turns;
      turns = yield* Effect.forEach(members, (one) =>
        Effect.map(
          nextTurn(one.bot.id, previous.find(([other]) => other === one)?.[1] ?? null),
          (turnId) => [one, turnId] as const,
        ),
      );
      const closing: Array<boolean> = [];
      const quiet: Array<boolean> = [];
      for (const [one, turnId] of turns) {
        closing.push((yield* lastEnvelope(one)).includes(ROOM_CLOSING_NOTE));
        const said = yield* say(one, turnId, {
          text: `${one.bot.profile.name}, wave ${waves.length + 1}.`,
        });
        quiet.push(wokeNobody(said));
      }
      for (const [one, turnId] of turns) yield* finish(one, turnId, members);
      waves.push({ closing, quiet });
      if (quiet.every(Boolean)) return waves;
    }
    return yield* Effect.die("the room never went quiet");
  });

for (const size of [2, 6]) {
  it.effect(
    `closes a room of ${size} and quiets it at the same rounds as any other, whatever its size`,
    () =>
      Effect.gen(function* () {
        const members = yield* Effect.forEach(
          ["Ana", "Bo", "Cy", "Di", "Ed", "Flo"].slice(0, size),
          member,
        );
        const [first, ...others] = members;
        if (first === undefined) return yield* Effect.die("a room has members");
        const room = yield* roomWith(first, others);
        yield* concurrentTurns(size);

        yield* operatorWrites(room.id, members, "Plan the launch together.", nobody);
        const waves = yield* everyoneAnswers(members);

        // Round n is the n-th wave: the operator's message, then each answer.
        const everyone = (value: boolean) => members.map(() => value);
        assert.deepStrictEqual(
          waves,
          Array.from({ length: ROOM_QUIET_ROUND + 1 }, (_, index) => ({
            closing: everyone(index + 1 >= ROOM_CLOSING_ROUND),
            quiet: everyone(index + 1 > ROOM_QUIET_ROUND),
          })),
        );
        const rounds = (yield* roundsIn(room.id)).slice(1);
        assert.deepStrictEqual(
          rounds.map(([, round]) => round),
          waves.flatMap((_, index) => members.map(() => index + 1)),
        );
        assert.deepStrictEqual(yield* noticesIn(room.id), [
          { _tag: "chain-stopped", limit: "room" },
        ]);
        assert.deepStrictEqual(yield* running(members), []);
        assert.strictEqual(yield* liveRoomWork(room.id), 0);
      }).pipe(Effect.provide(TestDomain.layer)),
  );
}

it.effect("starts the rounds again from the operator's word, steered into the turns that run", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
    const members = [ana, bo];
    const room = yield* roomWith(ana, [bo]);
    yield* concurrentTurns(2);
    yield* operatorWrites(room.id, members, "Pick a date.", nobody);

    // Two rounds of the two answering each other: the third is closing.
    let anaTurn = yield* nextTurn(ana.bot.id);
    let boTurn = yield* nextTurn(bo.bot.id);
    for (let round = 1; round < ROOM_CLOSING_ROUND; round++) {
      yield* say(ana, anaTurn, { text: `Ana, round ${round}.` });
      yield* say(bo, boTurn, { text: `Bo, round ${round}.` });
      yield* finish(ana, anaTurn, members);
      yield* finish(bo, boTurn, members);
      anaTurn = yield* nextTurn(ana.bot.id, anaTurn);
      boTurn = yield* nextTurn(bo.bot.id, boTurn);
    }
    assert.include(yield* lastEnvelope(ana), ROOM_CLOSING_NOTE);

    // The operator writes while both turns run: it is steered into them,
    // and what they say now answers it.
    yield* operatorWrites(room.id, members, "Friday. Confirm it.", nobody);
    assert.include(yield* lastEnvelope(ana), "Friday. Confirm it.");
    yield* control.readSteers({ sessionId: ana.session, turnId: anaTurn });
    yield* control.readSteers({ sessionId: bo.session, turnId: boTurn });
    yield* say(ana, anaTurn, { text: "Ana: Friday works." });
    yield* say(bo, boTurn, { text: "Bo: Friday works." });
    yield* finish(ana, anaTurn, members);
    yield* finish(bo, boTurn, members);

    assert.deepStrictEqual((yield* roundsIn(room.id)).slice(-3), [
      ["Friday. Confirm it.", 0],
      ["Ana: Friday works.", 1],
      ["Bo: Friday works.", 1],
    ]);
    // Each reads the other's answer as round 1: nothing is closing.
    yield* nextTurn(ana.bot.id, anaTurn);
    yield* nextTurn(bo.bot.id, boTurn);
    assert.include(yield* lastEnvelope(ana), "Bo: Friday works.");
    assert.notInclude(yield* lastEnvelope(ana), ROOM_CLOSING_NOTE);
    assert.notInclude(yield* lastEnvelope(bo), ROOM_CLOSING_NOTE);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers the newest round among the messages a member's waiting wakes share", () =>
  Effect.gen(function* () {
    const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
    const members = [hal, ana, bo];
    const room = yield* roomWith(hal, [ana, bo]);
    yield* concurrentTurns(3);

    // Ana is busy with a private turn while the room goes on without her.
    yield* sendToBot(ana.bot.id, "Read the contract.");
    const own = yield* nextTurn(ana.bot.id);
    yield* operatorWrites(room.id, members, "Hal, start the review.", to(hal));
    const halTurn = yield* nextTurn(hal.bot.id);
    yield* say(hal, halTurn, { text: "Ana, Bo: the scope?", mention: [ana.bot.id, bo.bot.id] });
    yield* finish(hal, halTurn, members);
    const boTurn = yield* nextTurn(bo.bot.id);
    yield* say(bo, boTurn, { text: "Ana: the API only.", mention: [ana.bot.id] });
    yield* finish(bo, boTurn, members);

    // Her two waiting wakes, of rounds 1 and 2, share one envelope: her
    // answer is round 3, so that envelope already says it is closing.
    yield* say(ana, own, { text: "Read.", done: true });
    yield* finish(ana, own, members);
    const anaTurn = yield* nextTurn(ana.bot.id, own);
    const envelope = yield* lastEnvelope(ana);
    assert.include(envelope, "Ana, Bo: the scope?");
    assert.include(envelope, "Ana: the API only.");
    assert.include(envelope, ROOM_CLOSING_NOTE);
    yield* say(ana, anaTurn, { text: "Agreed: the API only." });
    assert.deepStrictEqual((yield* roundsIn(room.id)).at(-1), ["Agreed: the API only.", 3]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

const SideTurn = Schema.Struct({ engine_session_id: SessionId, admitted_turn_id: TurnId });

/** The turn of the routine's run, once it runs in its side session. */
const routineTurn = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SideTurn,
      execute: (id) => sql`
        SELECT s.engine_session_id, s.admitted_turn_id FROM sessions s
        JOIN routine_runs r ON r.wake_id = s.side_wake_id
        WHERE r.routine_id = ${id} AND s.purpose = 'side' AND s.retired_at IS NULL
          AND s.engine_session_id IS NOT NULL AND s.admitted_turn_id IS NOT NULL
      `,
    });
    return yield* eventually(find(routineId).pipe(Effect.orDie));
  });

/** A routine of the bot's, run once now. */
const routineRuns = (botId: BotId) =>
  Effect.gen(function* () {
    const routines = yield* Routines;
    const routine = yield* routines.create({
      commandId: command(),
      botId,
      draft: { name: "Digest", instruction: "Post the digest.", trigger: { _tag: "webhook" } },
      author: { _tag: "operator" },
    });
    yield* routines.run({ commandId: command(), routineId: routine.id });
    return yield* routineTurn(routine.id);
  });

it.effect("puts a routine's post in a room one round past the room's newest", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
    const members = [ana, bo];
    const room = yield* roomWith(ana, [bo]);
    yield* operatorWrites(room.id, members, "Ana, ask Bo for the numbers.", to(ana));
    const anaTurn = yield* nextTurn(ana.bot.id);
    yield* say(ana, anaTurn, { text: "Bo, the numbers?", mention: [bo.bot.id] });
    yield* finish(ana, anaTurn, members);
    const boTurn = yield* nextTurn(bo.bot.id);
    yield* say(bo, boTurn, { text: "Ana, 12%.", mention: [ana.bot.id] });
    yield* finish(bo, boTurn, members);
    const anaLast = yield* nextTurn(ana.bot.id, anaTurn);
    yield* finish(ana, anaLast, members);

    // Ana's routine, outside the room, was shown none of it: its post
    // answers the room's newest round, 2, and Bo's reply would be round 4.
    const side = yield* routineRuns(ana.bot.id);
    const args = { to: room.id, text: "Digest: revenue grew 12%.", mention: [bo.bot.id] };
    yield* control.toolCall({
      sessionId: side.engine_session_id,
      turnId: side.admitted_turn_id,
      tool: "message_bot",
      input: args,
      recorded: "now",
    });
    const posted = yield* (yield* BotTools).call({
      requestId: "routine-post",
      sessionId: side.engine_session_id,
      tool: "message_bot",
      arguments: args,
    });
    assert.isFalse(wokeNobody(posted));
    assert.deepStrictEqual((yield* roundsIn(room.id)).at(-1), ["Digest: revenue grew 12%.", 3]);

    yield* nextTurn(bo.bot.id, boTurn);
    const envelope = yield* lastEnvelope(bo);
    assert.include(envelope, "Digest: revenue grew 12%.");
    assert.include(envelope, ROOM_CLOSING_NOTE);
  }).pipe(Effect.provide(TestDomain.layer)),
);
