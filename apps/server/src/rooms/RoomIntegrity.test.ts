// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { Conflict, type Entry, type QuestionEntry, type RoomId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
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
  roomWakesOf,
  roomWith,
  running,
  say,
  settle,
  stopRoom,
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  backgroundCheckDue,
  command,
  concurrentTurns,
  conversation,
  deliveryIs,
  failedAs,
  mainSessionId,
  nextTurn,
  noticesOf,
  sendToBot,
  stopSettled,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { DispatchSeq, ROOM_ROUND_HOLD_BOUND, SYNC_DEADLINE } from "../turns/model.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { RETRY_TICK } from "../turns/reconciler.ts";
import { Stops } from "../turns/Stops.ts";
import { Wakes } from "../turns/Wakes.ts";
import { Rooms } from "./Rooms.ts";

const isConflict = Schema.is(Conflict);

/** Why a command was refused: a `Conflict`'s reason, or the error's tag. */
const refusal = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => (isConflict(error) ? error.reason : error._tag));

/** The room's retryable notice, once it shows. */
const retryableNotice = (roomId: RoomId) =>
  Effect.gen(function* () {
    yield* until(
      Effect.map(roomEntries(roomId), (entries) =>
        entries.some((entry) => entry._tag === "notice" && entry.retryable),
      ),
    );
    const entries = yield* roomEntries(roomId);
    const found = entries.find(
      (entry): entry is Extract<Entry, { readonly _tag: "notice" }> =>
        entry._tag === "notice" && entry.retryable,
    );
    return Option.getOrThrow(Option.fromNullishOr(found));
  });

/** Whether background work one of the member's turns started still runs. */
const backgroundRuns = (one: Member) =>
  Effect.flatMap(TestEngineControl, (control) => control.backgroundWorkRunning(one.session));

let asks = 0;

/** The member asks, in its running room turn, which region to deploy to: the card, in its own conversation. */
const askInRoom = (one: Member, turnId: TurnId) =>
  Effect.gen(function* () {
    const args = {
      prompt: "Which region?",
      options: [{ label: "Europe", value: "eu-west-1" }],
      allow_custom: false,
    };
    yield* (yield* TestEngineControl).toolCall({
      sessionId: one.session,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: `room-ask-${++asks}`,
      sessionId: one.session,
      tool: "ask",
      arguments: args,
    });
    const found = (yield* conversation(one.bot.id)).findLast(
      (entry): entry is QuestionEntry => entry._tag === "question",
    );
    return Option.getOrThrow(Option.fromNullishOr(found));
  });

it.effect(
  "keeps a room message's failed wake through the room's archival, and retries it only once the room takes messages again",
  () =>
    Effect.gen(function* () {
      const pipeline = yield* Pipeline;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* (yield* TestEngineControl).rejectNextDispatch;
      const message = yield* operatorWrites(room.id, members, "Ana, pick a date.", to(ana));
      yield* deliveryIs(message, "failed");

      yield* archive(room.id, true);
      assert.strictEqual(
        yield* refusal(pipeline.retryMessage({ commandId: command(), entryId: message })),
        "room-archived",
      );
      assert.deepStrictEqual(yield* roomWakeStatuses(ana.bot.id, room.id), ["failed"]);

      yield* archive(room.id, false);
      yield* pipeline.retryMessage({ commandId: command(), entryId: message });
      yield* settle(members);
      const turn = yield* nextTurn(ana.bot.id);
      assert.include(yield* lastEnvelope(ana), "Ana, pick a date.");
      yield* finish(ana, turn, members);
      yield* deliveryIs(message, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers a Retry of a member's failed room turn, which runs it again in the room, and none once the member left",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const pipeline = yield* Pipeline;
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const failing = yield* nextTurn(hal.bot.id);
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: failing,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* turnEnded(hal.bot.id);
      const notice = yield* retryableNotice(room.id);
      assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "provider-error" });

      // The Retry runs Hal's turn again, in the room.
      yield* pipeline.retryNotice({ commandId: command(), entryId: notice.id });
      yield* settle(members);
      const again = yield* nextTurn(hal.bot.id);
      assert.include(yield* lastEnvelope(hal), "Plan the launch.");
      yield* say(hal, again, { text: "Ana, the numbers?", mention: [ana.bot.id] });

      // Ana's turn fails too, and Ana leaves before the operator retries it.
      yield* finish(hal, again, members);
      const anaTurn = yield* nextTurn(ana.bot.id);
      yield* control.finishTurn({
        sessionId: ana.session,
        turnId: anaTurn,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* turnEnded(ana.bot.id);
      const anaNotice = yield* retryableNotice(room.id);
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      const shown = (yield* roomEntries(room.id)).find((entry) => entry.id === anaNotice.id);
      assert.isFalse(shown?._tag === "notice" && shown.retryable);
      assert.strictEqual(
        yield* refusal(pipeline.retryNotice({ commandId: command(), entryId: anaNotice.id })),
        "not-retryable",
      );
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("writes no room wake for a room that takes no messages, whatever caused it", () =>
  Effect.gen(function* () {
    const wakes = yield* Wakes;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    const message = yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
    const turn = yield* nextTurn(hal.bot.id);
    yield* finish(hal, turn, members);
    yield* archive(room.id, true);

    const audience = { _tag: "room", roomId: room.id } as const;
    const causes = [
      { _tag: "operator" },
      { _tag: "routine" },
      { _tag: "work", seq: DispatchSeq.make(Number.MAX_SAFE_INTEGER) },
      { _tag: "teammate", senderId: hal.bot.id, audience, seq: null },
    ] as const;
    for (const cause of causes) {
      const written = yield* wakes.record([
        {
          botId: ana.bot.id,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: message, reason: "addressed" },
          sourceEntryId: message,
          hops: 0,
          retryOf: null,
          cause,
        },
      ]);
      assert.deepStrictEqual(written, []);
    }
    assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "stops a room's work with its Stop, background work its turns left too, and keeps the room taking messages",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // Ana runs for the room in the only turn slot, and the operator's next
      // word to Hal waits for it.
      yield* concurrentTurns(1);
      yield* operatorWrites(room.id, members, "Ana, draft the notes.", to(ana));
      const drafting = yield* nextTurn(ana.bot.id);
      const waiting = yield* operatorWrites(room.id, members, "Hal, and the date?", to(hal));

      yield* stopRoom(room.id);
      yield* turnEnded(ana.bot.id);
      assert.isFalse(yield* backgroundRuns(hal));
      yield* deliveryIs(waiting, "cancelled");
      assert.deepStrictEqual(yield* running(members), []);
      assert.notInclude(
        (yield* noticesIn(room.id)).map((notice) => notice._tag),
        "turn-failed",
      );

      // The room still takes the operator's word.
      yield* operatorWrites(room.id, members, "Ana, start again.", to(ana));
      yield* nextTurn(ana.bot.id, drafting);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "waits for a member's private turn before its room's Stop ends the room's work, and leaves private work alone",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // Ana's work is all private: the room's Stop has nothing of hers to end.
      yield* sendToBot(ana.bot.id, "Watch the deploy.");
      const deploying = yield* nextTurn(ana.bot.id);
      yield* control.startBackgroundWork({ sessionId: ana.session, turnId: deploying });
      yield* finish(ana, deploying, members);

      // Hal runs a turn for the operator when the room is stopped.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      const issued = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets WHERE issued_at IS NOT NULL
      `.pipe(Effect.orDie);
      assert.deepStrictEqual(issued, [{ n: 0 }]);
      assert.deepStrictEqual(yield* admittedTurn(hal.bot.id), Option.some(privately));
      assert.isTrue(yield* backgroundRuns(hal));

      // It ends: the room's Stop goes, and ends the build Hal watched, which
      // the engine shows ended on the next look.
      yield* finish(hal, privately, members);
      yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
      assert.isFalse(yield* backgroundRuns(hal));
      assert.isTrue(yield* backgroundRuns(ana));
      assert.notInclude(yield* noticesOf(hal.bot.id), "turn-failed");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "speaks in the room from a turn its room turn's background work started, and wakes the member it addresses",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);
      yield* operatorWrites(room.id, members, "Ana, get Bo to run the build.", to(ana));
      const asking = yield* nextTurn(ana.bot.id);
      yield* say(ana, asking, { text: "Bo, run the build.", mention: [bo.bot.id] });
      yield* finish(ana, asking, members);

      // Bo's room turn starts the build and ends.
      const building = yield* nextTurn(bo.bot.id);
      yield* control.startBackgroundWork({ sessionId: bo.session, turnId: building });
      yield* finish(bo, building, members);

      // The build wakes Bo's session with a turn that goes on with the room's
      // work: what it says goes to the room, not to Bo's conversation.
      const done = yield* control.startEngineTurn(bo.session, building);
      yield* nextTurn(bo.bot.id, building);
      yield* say(bo, done, { text: "Ana, it passed.", mention: [ana.bot.id] });
      yield* finish(bo, done, members);
      const said = (yield* roomEntries(room.id)).flatMap((entry) =>
        entry._tag === "message" ? [entry.text] : [],
      );
      assert.include(said, "Ana, it passed.");
      assert.deepStrictEqual(
        (yield* conversation(bo.bot.id)).filter((entry) => entry._tag === "message"),
        [],
      );
      yield* nextTurn(ana.bot.id, asking);
      assert.include(yield* lastEnvelope(ana), "Ana, it passed.");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "ends a removed member's work for the room: its turn stops, it says nothing more there, and its question expires",
  () =>
    Effect.gen(function* () {
      const [hal, ana, bo] = [yield* member("Hal"), yield* member("Ana"), yield* member("Bo")];
      const members = [hal, ana, bo];
      const room = yield* roomWith(hal, [ana, bo]);
      yield* operatorWrites(room.id, members, "Ana, pick a region.", to(ana));
      const turn = yield* nextTurn(ana.bot.id);
      const card = yield* askInRoom(ana, turn);

      // Ana speaks while the removal's Stop is still reaching her turn.
      const effects = yield* (yield* TestEngineControl).delayNextStopEffects;
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      const response = yield* say(ana, turn, { text: "Europe it is." });
      assert.include(JSON.stringify(response), "removed you from this room");
      yield* effects.release;
      yield* stopSettled;
      yield* turnEnded(ana.bot.id);

      const entries = yield* roomEntries(room.id);
      assert.isFalse(
        entries.some((entry) => entry._tag === "message" && entry.text === "Europe it is."),
      );
      const question = (yield* conversation(ana.bot.id)).find((entry) => entry.id === card.id);
      assert.deepStrictEqual(question?._tag === "question" ? question.status : null, {
        _tag: "expired",
      });
      assert.deepStrictEqual(yield* noticesIn(room.id), [
        { _tag: "waiting-in-conversation", botId: ana.bot.id },
      ]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** Whether the server still counts background work the member's turn started as pending. */
const flagged = (one: Member, turnId: TurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const session = yield* mainSessionId(one.bot.id);
    const [row] = yield* sql<{ readonly pending: number }>`
      SELECT background_pending AS pending FROM turns
      WHERE session_id = ${session} AND engine_turn_id = ${turnId}
    `.pipe(Effect.orDie);
    return row?.pending === 1;
  });

/** How many Stop targets are not settled yet. */
const unsettledTargets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM stop_targets WHERE stopped_at IS NULL
  `.pipe(Effect.orDie);
  return row?.n ?? 0;
});

/** How many Stop rounds were sent to the engine. */
const issuedRounds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM stop_targets WHERE issued_at IS NOT NULL
  `.pipe(Effect.orDie);
  return row?.n ?? 0;
});

it.effect("clears a room turn's background flag once the engine no longer lists its work", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
    const watching = yield* nextTurn(hal.bot.id);
    yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
    yield* finish(hal, watching, members);
    assert.isTrue(yield* flagged(hal, watching));

    // The build ends and wakes nothing; the next turn's end brings a report
    // that no longer lists it.
    yield* control.endBackgroundWork(hal.session);
    yield* sendToBot(hal.bot.id, "What is left today?");
    const privately = yield* nextTurn(hal.bot.id, watching);
    yield* say(hal, privately, { text: "Only the release notes.", done: true });
    yield* finish(hal, privately, members);
    yield* until(Effect.map(flagged(hal, watching), (pending) => !pending));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "settles a room's Stop without a round when its turns' background work already ended",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // The build ends while Hal's private turn runs, so no report clears its
      // flag yet. That turn starts work of its own, and is running when the
      // room is archived: the flag of the build is all the room has there.
      yield* sendToBot(hal.bot.id, "Watch the deploy.");
      const deploying = yield* nextTurn(hal.bot.id, watching);
      yield* control.endBackgroundWork(hal.session);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: deploying });
      yield* archive(room.id, true);
      assert.isTrue(yield* flagged(hal, watching));

      yield* finish(hal, deploying, members);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.isTrue(yield* backgroundRuns(hal));
      assert.isFalse(yield* flagged(hal, watching));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops background work a room turn left that its end did not tell of", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
    const watching = yield* nextTurn(hal.bot.id);
    // A monitor the agent does not await: only the engine's report lists it.
    yield* control.startBackgroundWork({
      sessionId: hal.session,
      turnId: watching,
      announced: false,
    });
    yield* finish(hal, watching, members);
    // The report that follows the room turn's end attributes it to that turn.
    yield* until(flagged(hal, watching));

    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
    yield* TestClock.adjust(RETRY_TICK);
    yield* stopSettled;
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "stops background work a room turn's end did not tell of before the report that lists it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const stops = yield* Stops;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({
        sessionId: hal.session,
        turnId: watching,
        announced: false,
      });
      // The report the room turn's end makes due never comes back, so
      // nothing flags the monitor before the room is stopped.
      const lost = yield* control.dropNextMarker;
      yield* finish(hal, watching, members);
      yield* lost.requested;
      assert.isFalse(yield* flagged(hal, watching));

      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* TestClock.adjust(SYNC_DEADLINE);
      yield* stops.runPending;
      yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds a room's Stop for work a room turn's end did not tell of while a turn no event shows starts",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const stops = yield* Stops;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({
        sessionId: hal.session,
        turnId: watching,
        announced: false,
      });
      const lost = yield* control.dropNextMarker;
      yield* finish(hal, watching, members);
      yield* lost.requested;

      // A harness's wake starts a turn no event shows yet: while it may run,
      // the engine's report lists no background work at all.
      const startup = yield* control.holdNextStartup(hal.session);
      yield* control.startEngineTurn(hal.session);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* TestClock.adjust(SYNC_DEADLINE);
      yield* stops.runPending;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.strictEqual(yield* unsettledTargets, 1);

      // The turn shows and ends: the report then lists the monitor, and the
      // room's Stop ends it.
      yield* startup.release;
      const woken = yield* nextTurn(hal.bot.id, watching);
      assert.isTrue(yield* backgroundRuns(hal));
      yield* finish(hal, woken, members);
      yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds a room's Stop while the engine starts a private turn no event shows yet", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
    const watching = yield* nextTurn(hal.bot.id);
    yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
    yield* finish(hal, watching, members);

    // The engine takes the operator's message and starts its turn, which
    // no event shows yet.
    const startup = yield* control.holdNextStartup(hal.session);
    yield* sendToBot(hal.bot.id, "What is left today?");
    const session = yield* mainSessionId(hal.bot.id);
    yield* until(
      Effect.map(
        sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM dispatches
            WHERE session_id = ${session} AND status = 'accepted' AND disposition = 'started'
          `.pipe(Effect.orDie),
        ([row]) => (row?.n ?? 0) > 0,
      ),
    );
    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* (yield* Stops).runPending;
    assert.strictEqual(yield* issuedRounds, 0);
    assert.isTrue(yield* backgroundRuns(hal));

    // Its turn shows and ends: the room's Stop ends the build.
    yield* startup.release;
    const privately = yield* nextTurn(hal.bot.id, watching);
    yield* finish(hal, privately, members);
    yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
    yield* TestClock.adjust(RETRY_TICK);
    yield* stopSettled;
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds a room's Stop for its turns' background work while the engine starts a turn no event shows yet",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // A harness's wake starts a turn, which no event shows yet: the report
      // the room's Stop asks for lists it as runnable.
      const startup = yield* control.holdNextStartup(hal.session);
      yield* control.startEngineTurn(hal.session);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.strictEqual(yield* unsettledTargets, 1);

      // The turn shows and ends: the room's Stop then ends the build.
      yield* startup.release;
      const woken = yield* nextTurn(hal.bot.id, watching);
      assert.isTrue(yield* backgroundRuns(hal));
      yield* finish(hal, woken, members);
      yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a room's Stop once its bound passed while a turn no event shows never starts",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // A harness's wake starts a turn whose provider never starts.
      yield* control.holdNextStartup(hal.session);
      yield* control.startEngineTurn(hal.session);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);

      yield* TestClock.adjust(ROOM_ROUND_HOLD_BOUND);
      yield* stopSettled;
      assert.isFalse(yield* backgroundRuns(hal));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a room's Stop once its bound passed while the private turn the engine took never shows, which fails as stopped",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // The engine takes the operator's message, and its turn never starts.
      yield* control.holdNextStartup(hal.session);
      const message = yield* sendToBot(hal.bot.id, "What is left today?");
      const session = yield* mainSessionId(hal.bot.id);
      yield* until(
        Effect.map(
          sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM dispatches
            WHERE session_id = ${session} AND status = 'accepted' AND disposition = 'started'
          `.pipe(Effect.orDie),
          ([row]) => (row?.n ?? 0) > 0,
        ),
      );
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);

      yield* TestClock.adjust(ROOM_ROUND_HOLD_BOUND);
      yield* stopSettled;
      assert.isFalse(yield* backgroundRuns(hal));
      yield* failedAs(message, "stopped");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "counts a room's Stop bound again from a private turn that started and ended between two passes",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // The engine takes the operator's message, whose turn no event shows
      // yet: the room's Stop waits on it, bounded.
      const startup = yield* control.holdNextStartup(hal.session);
      yield* sendToBot(hal.bot.id, "What is left today?");
      const session = yield* mainSessionId(hal.bot.id);
      yield* until(
        Effect.map(
          sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM dispatches
            WHERE session_id = ${session} AND status = 'accepted' AND disposition = 'started'
          `.pipe(Effect.orDie),
          ([row]) => (row?.n ?? 0) > 0,
        ),
      );
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);

      // Late in the bound, the turn shows; a harness's wake queues a turn
      // behind it, whose start no event will show. The private turn ends.
      yield* TestClock.adjust("110 seconds");
      yield* startup.release;
      const privately = yield* nextTurn(hal.bot.id, watching);
      yield* control.holdNextStartup(hal.session);
      yield* control.startEngineTurn(hal.session);
      yield* finish(hal, privately, members);

      // The wait on the woken turn counts from the private turn, not from
      // the first hold: past the first bound, the round still waits.
      yield* TestClock.adjust("30 seconds");
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.isTrue(yield* backgroundRuns(hal));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds a room's Stop past its bound while a private turn visibly runs", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
    const members = [hal, ana];
    const room = yield* roomWith(hal, [ana]);
    yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
    const watching = yield* nextTurn(hal.bot.id);
    yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
    yield* finish(hal, watching, members);

    yield* sendToBot(hal.bot.id, "What is left today?");
    const privately = yield* nextTurn(hal.bot.id, watching);
    yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
    yield* (yield* Stops).runPending;
    yield* TestClock.adjust(ROOM_ROUND_HOLD_BOUND);
    yield* (yield* Stops).runPending;
    assert.strictEqual(yield* issuedRounds, 0);
    assert.isTrue(yield* backgroundRuns(hal));

    // The turn ends on its own: the room's Stop then ends the build.
    yield* finish(hal, privately, members);
    yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
    yield* TestClock.adjust(RETRY_TICK);
    yield* stopSettled;
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** Whether the engine's latest hold of the member's queue was resumed. */
const queueResumed = (one: Member) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const session = yield* mainSessionId(one.bot.id);
    const [row] = yield* sql<{ readonly resumed: number }>`
      SELECT queue_held_cursor IS NOT NULL AND queue_held_cursor = queue_resumed_cursor AS resumed
      FROM sessions WHERE id = ${session}
    `.pipe(Effect.orDie);
    return row?.resumed === 1;
  });

it.effect(
  "cancels the operator's steer a failed turn requeued behind a held queue when the room's Stop goes, then resumes the queue",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // The operator talks to Hal in private and steers that turn; the
      // room's Stop waits for it.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id, watching);
      const steer = yield* sendToBot(hal.bot.id, "And the release notes?");
      yield* settle([hal]);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      assert.strictEqual(yield* issuedRounds, 0);

      // The turn fails before it takes the steer: the engine requeues the
      // steer as a turn of its own, behind the hold the failure left. It
      // cannot start, so the room's Stop goes, and cancels it with the build.
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: privately,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* turnEnded(hal.bot.id);
      yield* failedAs(steer, "stopped");
      yield* stopSettled;
      assert.isFalse(yield* backgroundRuns(hal));
      yield* until(queueResumed(hal));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "settles a room's Stop unsent when all that waits is the operator's steer a failed turn left in a held queue",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // The operator talks to Hal in private and steers that turn; the
      // room's Stop waits for it. The build ends meanwhile.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id, watching);
      const steer = yield* sendToBot(hal.bot.id, "And the release notes?");
      yield* settle([hal]);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* control.endBackgroundWork(hal.session);

      // The turn fails before it takes the steer, which waits behind the
      // hold the failure left. Nothing of the room is left: the Stop settles
      // with no round, and the steer runs once the queue resumes.
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: privately,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* turnEnded(hal.bot.id);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 0);
      yield* until(queueResumed(hal));
      yield* nextTurn(hal.bot.id, privately);
      yield* deliveryIs(steer, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "cancels the operator's steer a failed turn requeued, seen through a replacement, when the room's Stop goes",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { hal, privately, steer } = yield* Effect.gen(function* () {
        const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
        const members = [hal, ana];
        const room = yield* roomWith(hal, [ana]);
        yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
        const watching = yield* nextTurn(hal.bot.id);
        yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
        yield* finish(hal, watching, members);
        yield* sendToBot(hal.bot.id, "What is left today?");
        const privately = yield* nextTurn(hal.bot.id, watching);
        const steer = yield* sendToBot(hal.bot.id, "And the release notes?");
        yield* settle([hal]);
        yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
        assert.strictEqual(yield* issuedRounds, 0);
        return { hal, privately, steer };
      }).pipe(Effect.provide(Domain.layer));

      // While the server is down the turn fails before it takes the steer,
      // which the engine requeues behind the hold, and the engine forgets the
      // history the server's cursor names: the replacement lists the
      // follow-up waiting by the steer's key, with no `steer-requeued`.
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: privately,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* control.pruneHistory(hal.session);

      yield* Effect.gen(function* () {
        yield* failedAs(steer, "stopped");
        yield* stopSettled;
        assert.isFalse(yield* backgroundRuns(hal));
        yield* until(queueResumed(hal));
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "sends a room's Stop for its turns' background work only on a report the engine gave",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const stops = yield* Stops;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", to(hal));
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);
      yield* until(Effect.map(backgroundCheckDue(hal.bot.id), (due) => !due));

      // The report the room's Stop asks for never comes, and the next one is
      // asked for in vain too.
      const lost = yield* control.dropNextMarker;
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* lost.requested;
      const lostAgain = yield* control.dropNextMarker;
      yield* TestClock.adjust(SYNC_DEADLINE);
      const pass = yield* Effect.forkChild(stops.runPending);
      yield* lostAgain.requested;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.isTrue(yield* backgroundRuns(hal));

      // The build ends, and the next report shows nothing of the room left.
      yield* control.endBackgroundWork(hal.session);
      yield* TestClock.adjust(SYNC_DEADLINE);
      yield* Fiber.join(pass);
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.isFalse(yield* flagged(hal, watching));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "judges a room's Stop on the engine's report, not on events a stalled stream left stale",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* sendToBot(hal.bot.id, "Watch the deploy.");
      const deploying = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: deploying });
      yield* finish(hal, deploying, members);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const planning = yield* nextTurn(hal.bot.id, deploying);

      // Hal's stream stalls. The room's turn ends, and the deploy's
      // completion starts a private turn: the events still show the room's
      // turn running, so only the engine's report tells.
      const stall = yield* control.stallEvents(hal.session);
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: planning,
        outcome: { _tag: "completed" },
      });
      yield* control.endBackgroundWork(hal.session);
      yield* control.startEngineTurn(hal.session, deploying);
      const asked = yield* control.holdNext("synchronize");
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* asked.entered;
      assert.strictEqual(yield* issuedRounds, 0);

      // The stream catches up: the private turn runs to its end, and nothing
      // of the room is left.
      yield* asked.release;
      yield* stall.release;
      const completing = yield* nextTurn(hal.bot.id, planning);
      yield* finish(hal, completing, members);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds a room's Stop while a private turn no event shows starts ahead of the room's queued turn",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* sendToBot(hal.bot.id, "Watch the deploy.");
      const deploying = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: deploying });
      yield* finish(hal, deploying, members);

      // The deploy's completion wakes the session as the room's message
      // goes: its turn starts ahead of the room's, and no event shows it yet.
      const startup = yield* control.holdNextStartup(hal.session);
      yield* control.endBackgroundWork(hal.session);
      yield* control.startEngineTurnDuringNextDispatch(hal.session, deploying);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);

      // The private turn shows and runs to its end; the round then ends the
      // room's turn.
      yield* startup.release;
      const completing = yield* nextTurn(hal.bot.id, deploying);
      yield* finish(hal, completing, members);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "waits, bounded, on the wake of a room's background command queued behind a held queue, then cancels it",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Run the migration.", to(hal));
      const migrating = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: migrating });
      yield* finish(hal, migrating, members);

      // The operator talks to Hal in private; the room's Stop waits for it.
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id, migrating);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });

      // The migration completes, and its wake, which names no turn, waits
      // behind the private turn. That turn fails, and the engine holds the
      // queue: the wake may be the room's work, and the Stop waits on it.
      yield* control.endBackgroundWork(hal.session);
      yield* control.startEngineTurn(hal.session);
      yield* control.finishTurn({
        sessionId: hal.session,
        turnId: privately,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* turnEnded(hal.bot.id);
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* unsettledTargets, 1);
      assert.strictEqual(yield* issuedRounds, 0);

      // At the bound the round goes, and cancels the wake.
      yield* TestClock.adjust(ROOM_ROUND_HOLD_BOUND);
      yield* stopSettled;
      assert.strictEqual(yield* issuedRounds, 1);
      yield* until(queueResumed(hal));
      assert.isTrue(Option.isNone(yield* admittedTurn(hal.bot.id)));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows a retryable notice when the operator's Retry of a bot's room mention fails again",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const pipeline = yield* Pipeline;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Plan the launch.", to(hal));
      const planning = yield* nextTurn(hal.bot.id);
      yield* say(hal, planning, { text: "Ana, the numbers?", mention: [ana.bot.id] });
      yield* control.rejectNextDispatch;
      yield* finish(hal, planning, members);
      const first = yield* retryableNotice(room.id);

      // The operator retries it, and it fails before Ana gets it again.
      yield* control.rejectNextDispatch;
      yield* pipeline.retryNotice({ commandId: command(), entryId: first.id });
      yield* settle(members);
      const again = yield* retryableNotice(room.id);
      assert.notStrictEqual(again.id, first.id);
      assert.deepStrictEqual(again.notice, { _tag: "turn-failed", failure: "unknown" });
    }).pipe(Effect.provide(TestDomain.layer)),
);
