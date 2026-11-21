// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { Conflict, type Entry, type QuestionEntry, type RoomId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as TestDomain from "../testing/domain.ts";
import {
  finish,
  lastEnvelope,
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
  to,
} from "../testing/rooms.ts";
import {
  admittedTurn,
  chainLimits,
  command,
  conversation,
  deliveryIs,
  mainSessionId,
  messageTeammate,
  nextTurn,
  noticesOf,
  sendToBot,
  stopSettled,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { DispatchSeq } from "../turns/model.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { RETRY_TICK } from "../turns/reconciler.ts";
import { Stops } from "../turns/Stops.ts";
import { Wakes } from "../turns/Wakes.ts";
import { Rooms } from "./Rooms.ts";

const archive = (roomId: RoomId, archived: boolean) =>
  Effect.gen(function* () {
    yield* (yield* Rooms).update({ commandId: command(), roomId, changes: { archived } });
  });

const stopRoom = (roomId: RoomId) =>
  Effect.gen(function* () {
    yield* (yield* Rooms).stop({ commandId: command(), roomId });
    yield* stopSettled;
  });

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

/** The member asks, in its running room turn, which region to deploy to: the card. */
const askInRoom = (one: Member, turnId: TurnId, roomId: RoomId) =>
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
    const found = (yield* roomEntries(roomId)).findLast(
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
      yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
    const message = yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
          payload: { _tag: "room", entryId: message, reason: "mentioned" },
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
      yield* operatorWrites(room.id, members, "Watch the build.", nobody);
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);

      // Ana runs for the room, and the operator's next word to Hal waits.
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
      yield* operatorWrites(room.id, members, "Watch the build.", nobody);
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
  "speaks in the room from a turn its room turn's background work started, counting its hops from that turn",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo], 1);
      yield* operatorWrites(room.id, members, "Ana, get Bo to run the build.", to(ana));
      const asking = yield* nextTurn(ana.bot.id);
      yield* say(ana, asking, { text: "Bo, run the build.", mention: [bo.bot.id] });
      yield* finish(ana, asking, members);

      // Bo's turn, the chain's first hop, starts the build and ends.
      const building = yield* nextTurn(bo.bot.id);
      yield* control.startBackgroundWork({ sessionId: bo.session, turnId: building });
      yield* finish(bo, building, members);

      // The build wakes Bo's session with a turn of the room's, which counts
      // as the same hop: its mention would be the second.
      const done = yield* control.startEngineTurn(bo.session, building);
      yield* nextTurn(bo.bot.id, building);
      const response = yield* say(bo, done, { text: "Ana, it passed.", mention: [ana.bot.id] });
      assert.include(JSON.stringify(response), "limit of 1");
      yield* finish(bo, done, members);
      const said = (yield* roomEntries(room.id)).flatMap((entry) =>
        entry._tag === "message" ? [entry.text] : [],
      );
      assert.include(said, "Ana, it passed.");
      assert.strictEqual(yield* roomWakesOf(ana.bot.id, room.id), 1);
      assert.deepStrictEqual(
        (yield* conversation(bo.bot.id)).filter((entry) => entry._tag === "message"),
        [],
      );
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
      const card = yield* askInRoom(ana, turn, room.id);

      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { members: [hal.bot.id, bo.bot.id] },
      });
      const response = yield* say(ana, turn, { text: "Europe it is." });
      assert.include(JSON.stringify(response), "removed you from this room");
      yield* stopSettled;
      yield* turnEnded(ana.bot.id);

      const entries = yield* roomEntries(room.id);
      assert.isFalse(
        entries.some((entry) => entry._tag === "message" && entry.text === "Europe it is."),
      );
      const question = entries.find((entry) => entry.id === card.id);
      assert.deepStrictEqual(question?._tag === "question" ? question.status : null, {
        _tag: "expired",
      });
      assert.deepStrictEqual(yield* noticesIn(room.id), []);
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
    yield* operatorWrites(room.id, members, "Watch the build.", nobody);
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
      yield* operatorWrites(room.id, members, "Watch the build.", nobody);
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

it.effect(
  "holds a room's Stop while the engine has taken a private dispatch whose turn no event shows yet",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const [hal, ana] = [yield* member("Hal"), yield* member("Ana")];
      const members = [hal, ana];
      const room = yield* roomWith(hal, [ana]);
      yield* operatorWrites(room.id, members, "Watch the build.", nobody);
      const watching = yield* nextTurn(hal.bot.id);
      yield* control.startBackgroundWork({ sessionId: hal.session, turnId: watching });
      yield* finish(hal, watching, members);
      yield* sendToBot(hal.bot.id, "What is left today?");
      const privately = yield* nextTurn(hal.bot.id, watching);
      yield* say(hal, privately, { text: "Only the release notes.", done: true });
      yield* finish(hal, privately, members);

      // The engine has taken the operator's message, and no event has shown
      // its turn yet.
      const session = yield* mainSessionId(hal.bot.id);
      yield* sql`
        UPDATE dispatches SET status = 'accepted', engine_turn_id = NULL
        WHERE session_id = ${session} AND engine_turn_id = ${privately}
      `.pipe(Effect.orDie);
      yield* (yield* Rooms).stop({ commandId: command(), roomId: room.id });
      yield* (yield* Stops).runPending;
      assert.strictEqual(yield* issuedRounds, 0);
      assert.isTrue(yield* backgroundRuns(hal));

      // Its turn shows and ends: the room's Stop ends the build.
      yield* sql`
        UPDATE dispatches SET status = 'finished', engine_turn_id = ${privately}
        WHERE session_id = ${session} AND status = 'accepted'
      `.pipe(Effect.orDie);
      yield* (yield* Stops).runPending;
      yield* until(Effect.map(backgroundRuns(hal), (runs) => !runs));
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "does not refuse a harness's wake after the operator spoke because of an older room chain",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      yield* chainLimits({ hops: 1, fanOut: 1 });
      const [ana, bo] = [yield* member("Ana"), yield* member("Bo")];
      const members = [ana, bo];
      const room = yield* roomWith(ana, [bo]);
      yield* operatorWrites(room.id, members, "Ana, get Bo to run the build.", to(ana));
      const asking = yield* nextTurn(ana.bot.id);
      yield* say(ana, asking, { text: "Bo, run the build.", mention: [bo.bot.id] });
      yield* finish(ana, asking, members);

      // Bo's turn, a hop of the room's chain, starts the build.
      const building = yield* nextTurn(bo.bot.id);
      yield* control.startBackgroundWork({ sessionId: bo.session, turnId: building });
      yield* finish(bo, building, members);
      const session = yield* mainSessionId(bo.bot.id);
      yield* until(
        Effect.map(
          sql<{ readonly due: number }>`
            SELECT background_check_due AS due FROM sessions WHERE id = ${session}
          `.pipe(Effect.orDie),
          ([row]) => row?.due === 0,
        ),
      );
      yield* TestClock.adjust("1 second");

      // The operator asks Bo for a check in private, which wakes Bo once it
      // ends: a harness's wake, naming no turn.
      yield* sendToBot(bo.bot.id, "Check the logs, and tell Ana.");
      const checking = yield* nextTurn(bo.bot.id, building);
      yield* control.startBackgroundWork({ sessionId: bo.session, turnId: checking });
      yield* control.startEngineTurn(bo.session);
      yield* finish(bo, checking, members);
      const woken = yield* nextTurn(bo.bot.id, checking);

      const reply = yield* messageTeammate(bo.session, woken, {
        to: ana.bot.id,
        text: "The logs are clean.",
        urgent: false,
      });
      assert.strictEqual(reply._tag, "result");
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
      yield* operatorWrites(room.id, members, "Plan the launch.", nobody);
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
