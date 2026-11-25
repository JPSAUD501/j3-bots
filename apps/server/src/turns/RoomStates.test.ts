// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, Room, RoomId, RoomWorkState, RosterItem } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rooms } from "../rooms/Rooms.ts";
import { Roster } from "../roster/Roster.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  type Member,
  member,
  nobody,
  operatorWrites,
  roomWith,
  say,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  command,
  concurrentTurns,
  eventually,
  nextTurn,
  sendToBot,
  stopSettled,
  until,
} from "../testing/turns.ts";
import { RETRY_TICK } from "./reconciler.ts";

type ActiveRoom = Extract<Room, { readonly status: "active" }>;

/**
 * What the roster sent of the room, as `read` reads it, every time, in order,
 * from its snapshot on: a client sees each of these, the last one now.
 */
const watchRoom = <A>(roomId: RoomId, read: (room: ActiveRoom) => A) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<A>>([]);
    const sentIn = (items: ReadonlyArray<RosterItem>) =>
      items.flatMap((item) =>
        item._tag === "room" && item.room.id === roomId && item.room.status === "active"
          ? [read(item.room)]
          : [],
      );
    yield* (yield* Roster).subscribe.pipe(
      Stream.runForEach((frame) =>
        Ref.update(seen, (sent) => [
          ...sent,
          ...sentIn(frame._tag === "snapshot" ? frame.items : frame.upsert),
        ]),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* until(Effect.map(Ref.get(seen), (sent) => sent.length > 0));
    return seen;
  });

/** Every work the roster sent for the room. */
const watchRoomWork = (roomId: RoomId) => watchRoom(roomId, (room) => room.work);

/** The room's work the roster sent last, once it is `work`, and the server's. */
const shows = (seen: Ref.Ref<ReadonlyArray<RoomWorkState>>, roomId: RoomId, work: RoomWorkState) =>
  Effect.gen(function* () {
    yield* until(Effect.map(Ref.get(seen), (works) => works.at(-1) === work));
    const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
    assert.strictEqual(room.status === "active" ? room.work : null, work);
  });

it.effect(
  "shows a room's work running through its turn and the background work the turn left, stopping until its Stop settles, then none, with a roster push at each change",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      const seen = yield* watchRoomWork(room.id);
      yield* shows(seen, room.id, "none");

      // Hal's room turn runs, and starts a build it leaves running.
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* shows(seen, room.id, "running");
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);
      yield* shows(seen, room.id, "running");

      // Hal works for the operator alone when the room is stopped: the
      // room's Stop waits for that turn, and the room shows it stopping.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id, watching);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* shows(seen, room.id, "stopping");

      // That turn ends, the Stop ends the build, and nothing of the room is left.
      yield* finish(hal, privately, members);
      yield* until(control.backgroundWorkRunning(hal.session).pipe(Effect.map((runs) => !runs)));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
      yield* shows(seen, room.id, "none");
      assert.deepStrictEqual(dedupe(yield* Ref.get(seen)), ["none", "running", "stopping", "none"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a room's work none once a waiting wake for it is cancelled", () =>
  Effect.gen(function* () {
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    const seen = yield* watchRoomWork(room.id);

    // Both members are busy for the operator, so the room's wakes for them
    // wait for those turns: only the waiting wakes keep the room running.
    yield* sendToBot(hal.bot.id, "What is left today?");
    const halPrivately = yield* nextTurn(hal.bot.id);
    yield* sendToBot(ana.bot.id, "And for you?");
    const anaPrivately = yield* nextTurn(ana.bot.id);
    yield* operatorWrites(room.id, members, "The date?", nobody);
    yield* shows(seen, room.id, "running");

    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* shows(seen, room.id, "none");
    yield* finish(hal, halPrivately, members);
    yield* finish(ana, anaPrivately, members);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * Who answers in the room, as the roster sent it last, once it is
 * `answering`, and as the server has it.
 */
const answers = (
  seen: Ref.Ref<ReadonlyArray<ReadonlyArray<BotId>>>,
  roomId: RoomId,
  answering: ReadonlyArray<BotId>,
) =>
  Effect.gen(function* () {
    const same = (sent: ReadonlyArray<BotId> | undefined) =>
      sent !== undefined &&
      sent.length === answering.length &&
      sent.every((id, index) => id === answering[index]);
    yield* until(Effect.map(Ref.get(seen), (sent) => same(sent.at(-1))));
    const room = Option.getOrThrow(yield* (yield* Rooms).find(roomId));
    assert.deepStrictEqual(room.status === "active" ? room.answering : null, answering);
  });

it.effect(
  "shows who answers in a room, in member order, whether at work or waiting to start, until each has had its turn",
  () =>
    Effect.gen(function* () {
      yield* concurrentTurns(3);
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const seen = yield* watchRoom(room.id, (sent) => sent.answering);
      yield* answers(seen, room.id, []);

      // Hal is busy for the operator, so its turn for the room waits; it is
      // still named, in its place among the members.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id);
      yield* operatorWrites(room.id, members, "Morning, all.", nobody);
      yield* answers(seen, room.id, [hal.bot.id, ana.bot.id, bo.bot.id]);
      // Its own turn ends; whatever then runs for the room, the line stays.
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: hal.session,
        turnId: privately,
        outcome: { _tag: "completed" },
      });

      // Each member leaves the line as its turn for the room ends, in
      // whatever order the turns run, and the rest keep member order.
      let left = members;
      while (left.length > 0) {
        const [done, turnId] = yield* roomTurnOf(left, privately);
        yield* finish(done, turnId, members);
        left = left.filter((one) => one !== done);
        yield* answers(
          seen,
          room.id,
          left.map((one) => one.bot.id),
        );
      }
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** The first of `members` whose turn runs, and that turn, once one does, other than `not`. */
const roomTurnOf = (members: ReadonlyArray<Member>, not: TurnId) =>
  eventually(
    Effect.gen(function* () {
      for (const one of members) {
        const turnId = yield* admittedTurn(one.bot.id);
        if (Option.isSome(turnId) && turnId.value !== not) {
          return Option.some([one, turnId.value] as const);
        }
      }
      return Option.none();
    }),
  );

it.effect(
  "names every member answering in the room at once, one waiting for a turn slot too, and drops each as its turns end, in whatever order",
  () =>
    Effect.gen(function* () {
      yield* concurrentTurns(2);
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      const seen = yield* watchRoom(room.id, (sent) => sent.answering);

      // Hal and Ana answer at once, and Bo waits for a slot: all three answer.
      yield* operatorWrites(room.id, members, "Name one risk each.", nobody);
      const halTurn = yield* nextTurn(hal.bot.id);
      const anaTurn = yield* nextTurn(ana.bot.id);
      yield* answers(seen, room.id, [hal.bot.id, ana.bot.id, bo.bot.id]);

      // Ana ends first. Her reply, to nobody, waits for Hal's turn to end and
      // goes with the question to Bo, who takes her slot.
      yield* say(ana, anaTurn, { text: "The budget." });
      yield* finish(ana, anaTurn, members);
      const boTurn = yield* nextTurn(bo.bot.id);
      yield* answers(seen, room.id, [hal.bot.id, bo.bot.id]);

      // Hal answers again for her reply, and stays named in between.
      yield* finish(hal, halTurn, members);
      const halAgain = yield* nextTurn(hal.bot.id, halTurn);
      yield* answers(seen, room.id, [hal.bot.id, bo.bot.id]);
      yield* finish(bo, boTurn, members);
      yield* answers(seen, room.id, [hal.bot.id]);
      yield* finish(hal, halAgain, members);
      yield* answers(seen, room.id, []);

      // The roster sent each of those once, and nothing else.
      const names = new Map(members.map((one) => [one.bot.id, one.bot.profile.name]));
      const sent = (yield* Ref.get(seen))
        .map((ids) => ids.map((id) => names.get(id) ?? id).join(","))
        .filter((line, index, all) => index === 0 || all[index - 1] !== line);
      assert.deepStrictEqual(sent, ["", "Hal,Ana,Bo", "Hal,Bo", "Hal", ""]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** The works in order, each change once. */
const dedupe = (works: ReadonlyArray<RoomWorkState>) =>
  works.filter((work, index) => index === 0 || works[index - 1] !== work);
