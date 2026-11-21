// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { RoomId, RoomWorkState, RosterItem } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rooms } from "../rooms/Rooms.ts";
import { Roster } from "../roster/Roster.ts";
import * as TestDomain from "../testing/domain.ts";
import { finish, member, nobody, operatorWrites, roomWith } from "../testing/rooms.ts";
import { command, nextTurn, sendToBot, stopSettled, until } from "../testing/turns.ts";
import { RETRY_TICK } from "./reconciler.ts";

/**
 * Every work the roster sent for the room, in order, from its snapshot on:
 * a client sees each of these, the last one now.
 */
const watchRoomWork = (roomId: RoomId) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<RoomWorkState>>([]);
    const workIn = (items: ReadonlyArray<RosterItem>) =>
      items.flatMap((item) =>
        item._tag === "room" && item.room.id === roomId && item.room.status === "active"
          ? [item.room.work]
          : [],
      );
    yield* (yield* Roster).subscribe.pipe(
      Stream.runForEach((frame) =>
        Ref.update(seen, (works) => [
          ...works,
          ...workIn(frame._tag === "snapshot" ? frame.items : frame.upsert),
        ]),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* until(Effect.map(Ref.get(seen), (works) => works.length > 0));
    return seen;
  });

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
      yield* operatorWrites(room.id, members, "Watch the build.", nobody);
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

    // Hal is busy for the operator, so the room's wake for Hal waits.
    yield* sendToBot(hal.bot.id, "What is left today?");
    const privately = yield* nextTurn(hal.bot.id);
    yield* operatorWrites(room.id, members, "Hal, the date?", nobody);
    yield* shows(seen, room.id, "running");

    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* shows(seen, room.id, "none");
    yield* finish(hal, privately, members);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The works in order, each change once. */
const dedupe = (works: ReadonlyArray<RoomWorkState>) =>
  works.filter((work, index) => index === 0 || works[index - 1] !== work);
