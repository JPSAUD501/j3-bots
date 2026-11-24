// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, RoomId, RoomWorkState } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  lastEnvelope,
  member,
  operatorWrites,
  roomWakeStatuses,
  roomWith,
  running,
  say,
  settle,
  stopRoom,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  command,
  concurrentTurns,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { Rooms } from "./Rooms.ts";

/** The room's work as a client reads it. */
const workOf = (roomId: RoomId) =>
  Effect.gen(function* () {
    const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
    return room.status === "active" ? room.work : null;
  });

/** The room's newest entry each member's latest room dispatch was written through. */
const throughOf = (roomId: RoomId, botIds: ReadonlyArray<BotId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.forEach(botIds, (botId) =>
      sql<{ readonly through: number | null }>`
        SELECT room_through AS through FROM dispatches
        WHERE bot_id = ${botId} AND audience_room_id = ${roomId}
        ORDER BY seq DESC LIMIT 1
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.through ?? null),
      ),
    );
  });

it.effect(
  "starts the members the operator's message wakes at once, as far as the turn slots allow, and the last with the replies before it",
  () =>
    Effect.gen(function* () {
      yield* concurrentTurns(2);
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);

      yield* operatorWrites(room.id, members, "Name one risk each.", to(hal, ana, bo));
      const halTurn = yield* nextTurn(hal.bot.id);
      const anaTurn = yield* nextTurn(ana.bot.id);
      assert.deepStrictEqual(yield* running(members), ["Hal", "Ana"]);
      assert.deepStrictEqual(yield* roomWakeStatuses(bo.bot.id, room.id), ["pending"]);

      // Each answers without the other's reply: theirs started together.
      assert.notInclude(yield* lastEnvelope(ana), "The deadline.");
      yield* say(hal, halTurn, { text: "The deadline." });
      yield* say(ana, anaTurn, { text: "The budget." });
      yield* finish(hal, halTurn, members);

      // Bo takes the slot Hal left, and reads both replies with the question.
      yield* nextTurn(bo.bot.id);
      const envelope = yield* lastEnvelope(bo);
      assert.include(envelope, "Name one risk each.");
      assert.include(envelope, "The deadline.");
      assert.include(envelope, "The budget.");
      assert.strictEqual((yield* received(bo.session)).length, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("steers each member's running turn for the room with the operator's next word", () =>
  Effect.gen(function* () {
    yield* concurrentTurns(3);
    const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
    const members = [hal, ana, bo];
    const room = yield* roomWith(hal, [ana, bo]);
    yield* operatorWrites(room.id, members, "Draft the agenda.", to(hal, ana, bo));
    const turns = yield* Effect.forEach(members, (one) => nextTurn(one.bot.id));
    assert.deepStrictEqual(yield* running(members), ["Hal", "Ana", "Bo"]);

    yield* operatorWrites(room.id, members, "Keep it short.", to(hal, ana, bo));
    for (const [index, one] of members.entries()) {
      const sent = yield* received(one.session);
      assert.deepStrictEqual(
        sent.map((dispatch) => dispatch.delivery._tag),
        ["start", "steer"],
      );
      assert.include(sent[1]?.text ?? "", "Keep it short.");
      assert.deepStrictEqual(yield* admittedTurn(one.bot.id), Option.fromNullishOr(turns[index]));
    }
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives a member what the room said while its turn ran in one envelope after that turn, never a second turn beside it",
  () =>
    Effect.gen(function* () {
      yield* concurrentTurns(3);
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Pick a venue.", to(hal, ana, bo));
      const halTurn = yield* nextTurn(hal.bot.id);
      const anaTurn = yield* nextTurn(ana.bot.id);
      const boTurn = yield* nextTurn(bo.bot.id);

      yield* say(hal, halTurn, { text: "Ana: the old mill?", mention: [ana.bot.id] });
      yield* finish(hal, halTurn, members);
      yield* say(bo, boTurn, { text: "Ana: or the harbour hall?", mention: [ana.bot.id] });
      yield* finish(bo, boTurn, members);
      // Ana's turn still runs: what they said waits for it to end.
      assert.strictEqual((yield* received(ana.session)).length, 1);
      assert.deepStrictEqual(yield* admittedTurn(ana.bot.id), Option.some(anaTurn));

      yield* finish(ana, anaTurn, members);
      yield* nextTurn(ana.bot.id, anaTurn);
      const sent = yield* received(ana.session);
      assert.strictEqual(sent.length, 2);
      const envelope = sent[1]?.text ?? "";
      assert.include(envelope, "Ana: the old mill?");
      assert.include(envelope, "Ana: or the harbour hall?");
      assert.notInclude(envelope, "Pick a venue.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "writes two members' envelopes at the same moment, each with what that member has not seen",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      yield* concurrentTurns(2);
      const [hal, bo, ana, outsider] = [
        yield* member("Hal"),
        yield* member("Bo"),
        yield* member("Ana"),
        yield* member("Kit"),
      ];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [bo]);
      yield* operatorWrites(room.id, members, "Plan the offsite.", to(hal, bo));
      for (const one of [hal, bo]) yield* finish(one, yield* nextTurn(one.bot.id), members);

      // Ana joins after the first message; Kit's private turn holds the only slot.
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, ana.bot.id, bo.bot.id] },
      });
      yield* concurrentTurns(1);
      yield* sendToBot(outsider.bot.id, "Check the build.");
      const kitTurn = yield* nextTurn(outsider.bot.id);
      yield* operatorWrites(room.id, members, "Ana, welcome: pick a date.", to(hal, ana));
      assert.deepStrictEqual(yield* running(members), []);

      // Kit's turn ends and the budget allows both: one pass writes their envelopes.
      yield* control.finishTurn({
        sessionId: outsider.session,
        turnId: kitTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(outsider.bot.id);
      yield* concurrentTurns(3);
      yield* settle(members);
      yield* nextTurn(hal.bot.id, null);
      yield* nextTurn(ana.bot.id);
      const [halThrough, anaThrough] = yield* throughOf(room.id, [hal.bot.id, ana.bot.id]);
      assert.isNotNull(halThrough);
      assert.strictEqual(halThrough, anaThrough);

      const halEnvelope = yield* lastEnvelope(hal);
      assert.include(halEnvelope, "Ana, welcome: pick a date.");
      assert.notInclude(halEnvelope, "Plan the offsite.");
      const anaEnvelope = yield* lastEnvelope(ana);
      assert.include(anaEnvelope, "Ana, welcome: pick a date.");
      assert.include(anaEnvelope, "Plan the offsite.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops every member's running room turn at once with the room's Stop", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* concurrentTurns(3);
    const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
    const members = [hal, ana, bo];
    const room = yield* roomWith(hal, [ana, bo]);
    yield* operatorWrites(room.id, members, "Audit the logs.", to(hal, ana, bo));
    for (const one of members) yield* nextTurn(one.bot.id);
    assert.strictEqual<RoomWorkState | null>(yield* workOf(room.id), "running");

    yield* stopRoom(room.id);
    for (const one of members) yield* turnEnded(one.bot.id);
    assert.deepStrictEqual(yield* running(members), []);
    assert.strictEqual<RoomWorkState | null>(yield* workOf(room.id), "none");
    // The room's Stop is recorded for each member, in one transaction.
    const [targets] = yield* sql<{ readonly stops: number; readonly targets: number }>`
      SELECT COUNT(DISTINCT s.id) AS stops, COUNT(*) AS targets
      FROM stops s JOIN stop_targets t ON t.stop_id = s.id
      WHERE s.scope = 'room' AND s.room_id = ${room.id}
    `.pipe(Effect.orDie);
    assert.deepStrictEqual(targets, { stops: 3, targets: 3 });
  }).pipe(Effect.provide(TestDomain.layer)),
);
