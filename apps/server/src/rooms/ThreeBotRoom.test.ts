// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * M3's "done when", end to end: a room of bots completes a multi-step task
 * without a loop and without waking a bot that had nothing to do. Each bot
 * follows a scripted policy that answers the envelope it receives with tool
 * calls, and the test runs whichever bot the server wakes until the room is
 * quiet: the order of turns is the server's, not the test's.
 */
import { assert, it } from "@effect/vitest";
import type { RoomId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import { BotStore } from "../bots/BotStore.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  archive,
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
  say,
  settle,
  stopRoom,
} from "../testing/rooms.ts";
import { admittedTurn, eventually, received, turnEnded } from "../testing/turns.ts";

/** A turn the server started, as a bot's policy sees it. */
interface Turn {
  readonly member: Member;
  readonly turnId: TurnId;
  readonly envelope: string;
}

/** More turns than any of these tasks takes: past it, the room is looping. */
const RUNAWAY = 12;

/** Nothing of the room runs, is about to, or waits to. */
const quiet = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM wakes WHERE audience_room_id = ${roomId} AND status = 'pending'
    `.pipe(Effect.orDie);
    return (row?.n ?? 0) === 0 && (yield* liveRoomWork(roomId)) === 0;
  });

/**
 * Runs the room until it is quiet: each turn the server starts goes to its
 * bot's policy, and ends once the policy is done, unless the policy's own
 * action (a Stop, an archival) ended it. After the policy acts, every wake
 * that can go has gone, so a second turn running for the room shows. Returns
 * who ran, in order.
 */
const runUntilQuiet = <E, R>(
  roomId: RoomId,
  members: ReadonlyArray<Member>,
  policy: (turn: Turn) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const ran: Array<string> = [];
    while (true) {
      const next = yield* eventually(
        Effect.gen(function* () {
          for (const one of members) {
            const turnId = yield* admittedTurn(one.bot.id);
            if (Option.isSome(turnId)) {
              return Option.some(Option.some({ member: one, turnId: turnId.value }));
            }
          }
          return (yield* quiet(roomId)) ? Option.some(Option.none()) : Option.none();
        }),
      );
      if (Option.isNone(next)) return ran;
      const { member: one, turnId } = next.value;
      const name = one.bot.profile.name;
      ran.push(name);
      assert.isAtMost(ran.length, RUNAWAY, `the room never went quiet: ${ran.join(", ")}`);

      // The clock moves within each turn, so the turns' recorded spans can be compared.
      yield* TestClock.adjust("1 second");
      yield* policy({ member: one, turnId, envelope: yield* lastEnvelope(one) });
      yield* settle(members);
      const others = (yield* running(members)).filter((other) => other !== name);
      assert.deepStrictEqual(others, [], `${others.join(", ")} ran beside ${name}`);
      yield* TestClock.adjust("1 second");
      if (Option.isSome(yield* admittedTurn(one.bot.id))) yield* finish(one, turnId, members);
    }
  });

/** When each of the room's turns started and ended, in the order they started. */
const roomTurns = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({
        started_at: Schema.String,
        finished_at: Schema.NullOr(Schema.String),
      }),
      execute: (room) => sql`
        SELECT started_at, finished_at FROM turns WHERE audience_room_id = ${room}
        ORDER BY started_at, rowid
      `,
    })(roomId).pipe(Effect.orDie);
  });

/** Each of the room's turns started after the one before it ended. */
const assertOneAtATime = (roomId: RoomId) =>
  Effect.gen(function* () {
    const turns = yield* roomTurns(roomId);
    for (const [index, turn] of turns.entries()) {
      assert.isNotNull(turn.finished_at, "a room turn is still open");
      const previous = turns[index - 1];
      if (previous !== undefined && previous.finished_at !== null) {
        assert.isAtLeast(
          Date.parse(turn.started_at),
          Date.parse(previous.finished_at),
          "a room turn started while another ran",
        );
      }
    }
    return turns.length;
  });

const NOTE = "files/launch-note.md";

/** The member writes the file in its workspace, as its harness's tools would. */
const writeInWorkspace = (one: Member, file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = Option.getOrThrow(yield* (yield* BotStore).find(one.bot.id)).workspacePath;
    yield* fs.makeDirectory(path.dirname(path.join(workspace, file)), { recursive: true });
    yield* fs.writeFileString(path.join(workspace, file), text);
  });

/** The numbers Ana's research turns up, which reach Bo only through the room. */
const FINDING = "Sign-ups grew 18% in the beta.";

/**
 * The launch-note team: Hal hosts and hands the research to Ana, Ana reports
 * and hands the writing to Bo, Bo writes the note and hands it back, and Hal
 * closes. Each answers only what its envelope asks of it.
 */
const team = (hal: Member, ana: Member, bo: Member) => (turn: Turn) =>
  Effect.gen(function* () {
    switch (turn.member.bot.id) {
      case hal.bot.id: {
        if (turn.envelope.includes('reason="host"')) {
          yield* say(hal, turn.turnId, {
            text: "Ana, what do the beta numbers say?",
            mention: [ana.bot.id],
          });
        } else {
          yield* say(hal, turn.turnId, { text: "The launch note is ready.", done: true });
        }
        return;
      }
      case ana.bot.id: {
        yield* say(ana, turn.turnId, { text: `${FINDING} Bo, over to you.`, mention: [bo.bot.id] });
        return;
      }
      case bo.bot.id: {
        assert.include(turn.envelope, FINDING, "Bo was woken without Ana's finding");
        yield* writeInWorkspace(bo, NOTE, `# Launch\n\n${FINDING}\n`);
        yield* say(bo, turn.turnId, {
          text: "The note is drafted. Hal, have a look.",
          attachments: [NOTE],
          mention: [hal.bot.id],
        });
        return;
      }
      default:
        return yield* Effect.die(`${turn.member.bot.profile.name} had nothing to do here`);
    }
  });

/** Hal, Ana, Bo and the bystander Cy in a room Hal hosts. */
const launchRoom = Effect.gen(function* () {
  const [hal, ana, bo, cy] = [
    yield* member("Hal"),
    yield* member("Ana"),
    yield* member("Bo"),
    yield* member("Cy"),
  ];
  const members = [hal, ana, bo, cy];
  const room = yield* roomWith(hal, [ana, bo, cy]);
  return { hal, ana, bo, cy, members, room };
});

it.effect(
  "completes a three-bot task in four room turns, one at a time, without waking the bystander",
  () =>
    Effect.gen(function* () {
      const { hal, ana, bo, cy, members, room } = yield* launchRoom;
      yield* operatorWrites(room.id, members, "Write the launch note.", nobody);
      const ran = yield* runUntilQuiet(room.id, members, team(hal, ana, bo));

      assert.deepStrictEqual(ran, ["Hal", "Ana", "Bo", "Hal"]);
      assert.strictEqual(yield* assertOneAtATime(room.id), 4);
      assert.strictEqual(yield* roomWakesOf(cy.bot.id, room.id), 0);
      assert.deepStrictEqual(yield* received(cy.session), []);
      assert.deepStrictEqual(yield* noticesIn(room.id), []);

      // Every message reached everyone it addressed, the note with Bo's.
      const messages = (yield* roomEntries(room.id)).flatMap((entry) =>
        entry._tag === "message" ? [entry] : [],
      );
      assert.strictEqual(messages.length, 5);
      for (const message of messages) assert.strictEqual(message.delivery._tag, "delivered");
      const note = messages.find((message) => message.attachments.length > 0);
      assert.deepStrictEqual(
        note?.attachments.map((file) => file.name),
        ["launch-note.md"],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "stops two bots that always hand back to each other at the room's hop limit, with one notice",
  () =>
    Effect.gen(function* () {
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      // The default hop limit, which the room takes from the settings.
      const room = yield* roomWith(ana, [bo]);
      assert.strictEqual(room.hopLimit, 4);

      yield* operatorWrites(room.id, members, "Agree on a date.", nobody);
      const ran = yield* runUntilQuiet(room.id, members, (turn) => {
        const other = turn.member === ana ? bo : ana;
        return say(turn.member, turn.turnId, {
          text: `${other.bot.profile.name}, what about later?`,
          mention: [other.bot.id],
        });
      });

      // The operator's word starts the chain; four hops later the fifth mention wakes nobody.
      assert.deepStrictEqual(ran, ["Ana", "Bo", "Ana", "Bo", "Ana"]);
      assert.strictEqual(yield* assertOneAtATime(room.id), 5);
      assert.deepStrictEqual(yield* noticesIn(room.id), [{ _tag: "chain-stopped", limit: "hops" }]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels the rest of the chain when the room is archived in the middle of it", () =>
  Effect.gen(function* () {
    const { hal, ana, bo, cy, members, room } = yield* launchRoom;
    const work = team(hal, ana, bo);

    yield* operatorWrites(room.id, members, "Write the launch note.", nobody);
    const ran = yield* runUntilQuiet(room.id, members, (turn) =>
      Effect.gen(function* () {
        yield* work(turn);
        // Ana has handed the writing on, and the operator archives the room.
        if (turn.member === ana) {
          yield* archive(room.id, true);
          yield* turnEnded(ana.bot.id);
        }
      }),
    );

    assert.deepStrictEqual(ran, ["Hal", "Ana"]);
    assert.strictEqual(yield* assertOneAtATime(room.id), 2);
    assert.deepStrictEqual(yield* roomWakeStatuses(bo.bot.id, room.id), ["cancelled"]);
    assert.deepStrictEqual(yield* received(bo.session), []);
    assert.strictEqual(yield* roomWakesOf(hal.bot.id, room.id), 1);
    assert.strictEqual(yield* roomWakesOf(cy.bot.id, room.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "ends the background task Ana's room turn started when the operator stops the room later in the chain",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { hal, ana, bo, cy, members, room } = yield* launchRoom;
      const work = team(hal, ana, bo);

      yield* operatorWrites(room.id, members, "Write the launch note.", nobody);
      const ran = yield* runUntilQuiet(room.id, members, (turn) =>
        Effect.gen(function* () {
          if (turn.member === ana) {
            // Ana leaves a long query running and hands on.
            yield* control.startBackgroundWork({ sessionId: ana.session, turnId: turn.turnId });
            yield* work(turn);
          } else if (turn.member === bo) {
            // While Bo drafts, the operator stops the room.
            assert.isTrue(yield* control.backgroundWorkRunning(ana.session));
            yield* stopRoom(room.id);
            yield* turnEnded(bo.bot.id);
          } else {
            yield* work(turn);
          }
        }),
      );

      assert.deepStrictEqual(ran, ["Hal", "Ana", "Bo"]);
      assert.isFalse(yield* control.backgroundWorkRunning(ana.session));
      assert.strictEqual(yield* assertOneAtATime(room.id), 3);
      assert.strictEqual(yield* roomWakesOf(hal.bot.id, room.id), 1);
      assert.strictEqual(yield* roomWakesOf(cy.bot.id, room.id), 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);
