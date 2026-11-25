// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * M3's "done when", end to end: a room of bots completes a multi-step task
 * without a loop, a mention waking only the member named, every member
 * reading what was said in its next turn, and a member with nothing to add
 * saying nothing. Each bot follows a scripted policy that
 * answers the envelope it receives with tool calls, and the test runs
 * whichever bots the server wakes until the room is quiet: which turns run,
 * and beside which, is the server's choice, not the test's.
 */
import { assert, it } from "@effect/vitest";
import { ROOM_QUIET_AFTER, type RoomId } from "@j3-bots/contracts";
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
  roomWith,
  running,
  sawText,
  say,
  settle,
  stopRoom,
  to,
} from "../testing/rooms.ts";
import { ROOM_CLOSING_NOTE } from "@j3-bots/prompts";
import {
  admittedTurn,
  concurrentTurns,
  eventually,
  received,
  turnEnded,
} from "../testing/turns.ts";

/** A turn the server started, as a bot's policy sees it. */
interface Turn {
  readonly member: Member;
  readonly turnId: TurnId;
  readonly envelope: string;
}

/** More turns than any of these tasks takes: past it, the room is looping. */
const RUNAWAY = 16;

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
 * Runs the room until it is quiet: of the turns the server runs, the one seen
 * first goes to its bot's policy, and ends once the policy is done, unless
 * the policy's own action (a Stop, an archival) ended it. The others run on
 * meanwhile and are taken in the order they were seen. Returns who ran, in
 * that order.
 */
const runUntilQuiet = <E, R>(
  roomId: RoomId,
  members: ReadonlyArray<Member>,
  policy: (turn: Turn) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const ran: Array<string> = [];
    // The turns running, oldest first.
    let seen: ReadonlyArray<{ readonly member: Member; readonly turnId: TurnId }> = [];
    while (true) {
      const next = yield* eventually(
        Effect.gen(function* () {
          const now: Array<{ readonly member: Member; readonly turnId: TurnId }> = [];
          for (const one of members) {
            const turnId = yield* admittedTurn(one.bot.id);
            if (Option.isSome(turnId)) now.push({ member: one, turnId: turnId.value });
          }
          const same = (a: { readonly turnId: TurnId }) => (b: { readonly turnId: TurnId }) =>
            a.turnId === b.turnId;
          seen = [
            ...seen.filter((turn) => now.some(same(turn))),
            ...now.filter((turn) => !seen.some(same(turn))),
          ];
          const [first] = seen;
          if (first !== undefined) return Option.some(Option.some(first));
          return (yield* quiet(roomId)) ? Option.some(Option.none()) : Option.none();
        }),
      );
      if (Option.isNone(next)) return ran;
      const { member: one, turnId } = next.value;
      seen = seen.slice(1);
      const name = one.bot.profile.name;
      ran.push(name);
      assert.isAtMost(ran.length, RUNAWAY, `the room never went quiet: ${ran.join(", ")}`);

      // The clock moves within each turn, so the turns' recorded spans can be compared.
      yield* TestClock.adjust("1 second");
      yield* policy({ member: one, turnId, envelope: yield* lastEnvelope(one) });
      yield* settle(members);
      yield* TestClock.adjust("1 second");
      if (Option.isSome(yield* admittedTurn(one.bot.id))) yield* finish(one, turnId, members);
    }
  });

/** When each of the room's turns started and ended, by member and then in the order they started. */
const roomTurns = (roomId: RoomId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({
        bot_id: Schema.String,
        started_at: Schema.String,
        finished_at: Schema.NullOr(Schema.String),
      }),
      execute: (room) => sql`
        SELECT s.bot_id AS bot_id, t.started_at AS started_at, t.finished_at AS finished_at
        FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE t.audience_room_id = ${room}
        ORDER BY s.bot_id, t.started_at, t.rowid
      `,
    })(roomId).pipe(Effect.orDie);
  });

/**
 * Each member's turns for the room started after its turn before them ended,
 * whatever the other members ran meanwhile. Returns how many turns the room
 * ran, and how many of them started while another member's ran.
 */
const assertOneTurnPerMember = (roomId: RoomId) =>
  Effect.gen(function* () {
    const turns = yield* roomTurns(roomId);
    let beside = 0;
    for (const [index, turn] of turns.entries()) {
      assert.isNotNull(turn.finished_at, "a room turn is still open");
      const previous = turns[index - 1];
      if (previous?.bot_id === turn.bot_id && previous.finished_at !== null) {
        assert.isAtLeast(
          Date.parse(turn.started_at),
          Date.parse(previous.finished_at),
          "a member started a room turn while its last one ran",
        );
      }
      const started = Date.parse(turn.started_at);
      const overlaps = turns.some(
        (other) =>
          other.bot_id !== turn.bot_id &&
          Date.parse(other.started_at) < started &&
          (other.finished_at === null || Date.parse(other.finished_at) > started),
      );
      if (overlaps) beside++;
    }
    return { turns: turns.length, beside };
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
 * The launch-note team. Each speaks only when it is addressed with something
 * to do, and hands on with a mention: Hal, the operator's lead, asks Ana for
 * the numbers and closes once Bo hands the note back; Ana reports to Bo; Bo
 * writes the note. Cy, whose part none of it is, reads along and says
 * nothing, and so does every member a message does not address.
 */
const team = (hal: Member, ana: Member, bo: Member) => (turn: Turn) =>
  Effect.gen(function* () {
    const addressed = turn.envelope.includes('reason="addressed"');
    switch (turn.member.bot.id) {
      case hal.bot.id: {
        if (turn.envelope.includes("Write the launch note.")) {
          yield* say(hal, turn.turnId, {
            text: "Ana, what do the beta numbers say?",
            mention: [ana.bot.id],
          });
        } else if (addressed && turn.envelope.includes("The note is drafted.")) {
          yield* say(hal, turn.turnId, { text: "The launch note is ready.", done: true });
        }
        return;
      }
      case ana.bot.id: {
        if (addressed && turn.envelope.includes("what do the beta numbers say?")) {
          yield* say(ana, turn.turnId, {
            text: `${FINDING} Bo, over to you.`,
            mention: [bo.bot.id],
          });
        }
        return;
      }
      case bo.bot.id: {
        if (addressed && turn.envelope.includes("Bo, over to you.")) {
          assert.include(turn.envelope, FINDING, "Bo was handed the note without Ana's finding");
          yield* writeInWorkspace(bo, NOTE, `# Launch\n\n${FINDING}\n`);
          yield* say(bo, turn.turnId, {
            text: "The note is drafted. Hal, have a look.",
            attachments: [NOTE],
            mention: [hal.bot.id],
          });
        }
        return;
      }
      default:
        return;
    }
  });

/** Hal, Ana, Bo and the bystander Cy in a room, in that order. */
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
  "completes a three-bot task the operator gave the whole room, its members answering at once and each hand-off waking only the member named",
  () =>
    Effect.gen(function* () {
      const { hal, ana, bo, cy, members, room } = yield* launchRoom;
      yield* operatorWrites(room.id, members, "Write the launch note.", nobody);
      const ran = yield* runUntilQuiet(room.id, members, team(hal, ana, bo));

      // The operator's message wakes every member, two at a time as the turn
      // slots allow, each reading it as it was sent: only Hal acts on it. Ana,
      // asked while her turn ran, answers in her next turn and hands to Bo,
      // whose next turn writes the note. Bo's hand back wakes Hal alone, and
      // Hal's closing line, which mentions nobody, wakes the others, who say
      // nothing.
      assert.deepStrictEqual(ran, [
        "Hal",
        "Ana",
        "Bo",
        "Cy",
        "Ana",
        "Bo",
        "Hal",
        "Ana",
        "Bo",
        "Cy",
      ]);
      const { turns, beside } = yield* assertOneTurnPerMember(room.id);
      assert.strictEqual(turns, 10);
      assert.isAbove(beside, 0);
      assert.deepStrictEqual(yield* noticesIn(room.id), []);

      // Cy was woken by the messages to the whole room alone, and read every
      // message, the hand-offs among them, in its two turns without a word.
      const messages = (yield* roomEntries(room.id)).flatMap((entry) =>
        entry._tag === "message" ? [entry] : [],
      );
      assert.deepStrictEqual(
        messages.map((message) => message.text),
        [
          "Write the launch note.",
          "Ana, what do the beta numbers say?",
          `${FINDING} Bo, over to you.`,
          "The note is drafted. Hal, have a look.",
          "The launch note is ready.",
        ],
      );
      for (const message of messages) assert.strictEqual(message.delivery._tag, "delivered");
      const note = messages.find((message) => message.attachments.length > 0);
      assert.deepStrictEqual(
        note?.attachments.map((file) => file.name),
        ["launch-note.md"],
      );
      assert.deepStrictEqual(yield* roomWakeStatuses(cy.bot.id, room.id), ["finished", "finished"]);
      assert.isTrue(yield* sawText(cy, "Bo, over to you."));
      assert.isTrue(yield* sawText(cy, "The launch note is ready."));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "quiets two bots that always hand back to each other once they have said enough without the operator, with one notice",
  () =>
    Effect.gen(function* () {
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);

      yield* operatorWrites(room.id, members, "Agree on a date.", to(ana));
      const ran = yield* runUntilQuiet(room.id, members, (turn) => {
        const other = turn.member === ana ? bo : ana;
        return say(turn.member, turn.turnId, {
          text: `${other.bot.profile.name}, what about later?`,
          mention: [other.bot.id],
        });
      });

      // Each answers the other, one message a turn, until the message past
      // the room's limit since the operator wrote is posted and wakes nobody.
      assert.strictEqual(ran.length, ROOM_QUIET_AFTER + 1);
      assert.strictEqual((yield* assertOneTurnPerMember(room.id)).turns, ROOM_QUIET_AFTER + 1);
      assert.deepStrictEqual(yield* noticesIn(room.id), [{ _tag: "chain-stopped", limit: "room" }]);
      // From the closing point on, each was told the conversation is closing.
      assert.isTrue(yield* sawText(ana, ROOM_CLOSING_NOTE));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels the rest of the chain when the room is archived in the middle of it", () =>
  Effect.gen(function* () {
    const { hal, ana, bo, cy, members, room } = yield* launchRoom;
    const work = team(hal, ana, bo);
    // One turn slot, so the members take the room one after another.
    yield* concurrentTurns(1);

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

    // Bo and Cy, who had not read the room yet, never will.
    assert.deepStrictEqual(ran, ["Hal", "Ana"]);
    assert.strictEqual((yield* assertOneTurnPerMember(room.id)).turns, 2);
    assert.deepStrictEqual(yield* roomWakeStatuses(hal.bot.id, room.id), ["finished"]);
    assert.deepStrictEqual(yield* roomWakeStatuses(bo.bot.id, room.id), ["cancelled", "cancelled"]);
    assert.deepStrictEqual(yield* roomWakeStatuses(cy.bot.id, room.id), ["cancelled"]);
    for (const one of [bo, cy]) assert.deepStrictEqual(yield* received(one.session), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "ends the background task Ana's room turn started when the operator stops the room later in the chain",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { hal, ana, bo, cy, members, room } = yield* launchRoom;
      const work = team(hal, ana, bo);
      // One turn slot, so the members take the room one after another.
      yield* concurrentTurns(1);

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
      assert.strictEqual((yield* assertOneTurnPerMember(room.id)).turns, 3);
      // The Stop cancels what Cy had yet to read.
      assert.deepStrictEqual(yield* roomWakeStatuses(cy.bot.id, room.id), ["cancelled"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);
