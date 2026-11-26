// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  type Member,
  member,
  operatorWrites,
  roomEntries,
  roomWith,
  say,
  stopRoom,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  flushed,
  gateSettled,
  nextTurn,
  sendToBot,
  timesSent,
  turnEnded,
} from "../testing/turns.ts";

// A delegated task's result belongs to the audience whose turn delegated it
// (`docs/architecture/server.md`, Delegated results). The engine steers it
// into whatever turn runs when it finishes, so a result of room work can
// reach the bot in a turn of its own conversation: J3 Bots brings it back to
// the room as a wake of the room's.

const RESULT = "Delegated task node-1 [completed]:\nThe Harbor Hall is free on Friday.";

/**
 * Scout delegates research in the room, then works in its own conversation
 * when the result lands there.
 */
const resultLandsElsewhere = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const scout = yield* member("Scout");
  const wren = yield* member("Wren");
  const members: ReadonlyArray<Member> = [scout, wren];
  const room = yield* roomWith(scout, [wren]);
  yield* operatorWrites(room.id, members, "Scout, find a venue for Friday.", to(scout));
  const roomTurn = yield* nextTurn(scout.bot.id);
  yield* say(scout, roomTurn, { text: "I've asked a helper to look.", done: true });
  yield* finish(scout, roomTurn, members);

  yield* sendToBot(scout.bot.id, "Anything on my calendar today?");
  const ownTurn = yield* nextTurn(scout.bot.id, roomTurn);
  yield* control.delegatedResult({
    sessionId: scout.session,
    turnId: ownTurn,
    origin: roomTurn,
    text: RESULT,
  });
  return { control, scout, members, room, roomTurn, ownTurn };
});

it.effect("brings a result that reached another conversation back to the room that asked", () =>
  Effect.gen(function* () {
    const { scout, members, room, roomTurn, ownTurn } = yield* resultLandsElsewhere;
    yield* say(scout, ownTurn, { text: "Your calendar is clear.", done: true });
    yield* finish(scout, ownTurn, members);

    const resultTurn = yield* nextTurn(scout.bot.id, ownTurn);
    assert.strictEqual(yield* timesSent(scout.session, "The Harbor Hall is free on Friday."), 1);
    // The turn counts as the room turn's work, for its hops and its Stops.
    const sql = yield* SqlClient.SqlClient;
    const origins = yield* sql<{ readonly origin_turn_id: string | null }>`
      SELECT origin_turn_id FROM turns WHERE engine_turn_id = ${resultTurn}
    `;
    assert.deepStrictEqual(origins, [{ origin_turn_id: roomTurn }]);
    // What Scout says in it reaches the room.
    yield* say(scout, resultTurn, { text: "The Harbor Hall is free on Friday.", done: true });
    const said = (yield* roomEntries(room.id)).flatMap((entry) =>
      entry._tag === "message" ? [entry.text] : [],
    );
    assert.include(said, "The Harbor Hall is free on Friday.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("drops the result of work the operator stopped in the room", () =>
  Effect.gen(function* () {
    const { scout, members, room, ownTurn } = yield* resultLandsElsewhere;
    yield* stopRoom(room.id);
    // The room's Stop leaves Scout's own conversation alone.
    yield* say(scout, ownTurn, { text: "Your calendar is clear.", done: true });
    yield* finish(scout, ownTurn, members);

    yield* flushed(scout.bot.id);
    assert.isTrue((yield* admittedTurn(scout.bot.id))._tag === "None");
    assert.strictEqual(yield* timesSent(scout.session, "The Harbor Hall is free on Friday."), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("brings a result back once when the engine shows it again", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { scout, ownTurn } = yield* Effect.gen(function* () {
      const landed = yield* resultLandsElsewhere;
      yield* say(landed.scout, landed.ownTurn, { text: "Your calendar is clear.", done: true });
      yield* gateSettled(landed.scout.bot.id);
      return landed;
    }).pipe(Effect.provide(Domain.layer));

    // While the server is down the engine forgets the history the server's
    // cursor names, so it lists the result again in a replacement.
    yield* control.finishTurn({
      sessionId: scout.session,
      turnId: ownTurn,
      outcome: { _tag: "completed" },
    });
    yield* control.pruneHistory(scout.session);

    yield* Effect.gen(function* () {
      const resultTurn = yield* nextTurn(scout.bot.id, ownTurn);
      yield* say(scout, resultTurn, { text: "The Harbor Hall is free on Friday.", done: true });
      yield* control.finishTurn({
        sessionId: scout.session,
        turnId: resultTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(scout.bot.id);
      yield* flushed(scout.bot.id);
      assert.strictEqual(yield* timesSent(scout.session, "The Harbor Hall is free on Friday."), 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);
