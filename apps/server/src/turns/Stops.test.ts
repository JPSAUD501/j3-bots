// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, WorkStepId } from "@j3-bots/contracts";
import type { SessionId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  admittedTurn,
  answerFirstOption,
  askRegion,
  awaitEntry,
  command,
  createBot,
  deliveryIs,
  engineSession,
  eventually,
  flushed,
  gateSettled,
  nextTurn,
  received,
  noticesOf,
  recoverTimes,
  roomOf,
  sendInRoom,
  sendToBot,
  stopSettled,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { MAX_INDETERMINATE_ANSWERS, recoveryBackoff, stopGrace, SYNC_DEADLINE } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { RETRY_TICK } from "./reconciler.ts";
import { Stops } from "./Stops.ts";

it.effect("keeps a message sent after a Stop retryable when both share a timestamp", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Rewrite the intro.");
    yield* nextTurn(bot.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* stopSettled;
    yield* turnEnded(bot.id);

    // In the same millisecond as the Stop, a new message is refused.
    yield* control.rejectNextDispatch;
    const message = yield* sendToBot(bot.id, "Now the outro.");
    const delivery = yield* eventually(
      entries
        .find(message)
        .pipe(
          Effect.map((found) =>
            Option.isSome(found) &&
            found.value.entry._tag === "message" &&
            found.value.entry.delivery._tag !== "pending"
              ? Option.some(found.value.entry.delivery)
              : Option.none(),
          ),
        ),
    );
    const [same] = yield* sql<{ readonly same: number }>`
      SELECT s.created_at = d.created_at AS same FROM stops s, dispatches d
      WHERE d.status = 'failed'
    `.pipe(Effect.orDie);
    assert.strictEqual(same?.same, 1);

    // It came after the Stop: it failed, and the operator may send it again.
    assert.strictEqual(delivery._tag, "failed");
    yield* (yield* Pipeline).retryMessage({ commandId: command(), entryId: message });
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Now the outro."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("confirms a Stop past a steer the engine never settles, and applies it if it does", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Rewrite the intro.");
    const turnId = yield* nextTurn(bot.id);
    const steer = yield* sendToBot(bot.id, "Keep it short.");
    yield* until(Effect.map(deliveriesOf(session, "Keep it short."), (sent) => sent.length > 0));
    yield* control.readSteers({ sessionId: session, turnId });
    // An engine fault: the turn the Stop ends settles its steer with no event.
    const withheld = yield* control.withholdNextSteerSettlements;

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* stopSettled;
    yield* turnEnded(bot.id);
    yield* deliveryIs(steer, "cancelled");
    // The session takes work again.
    yield* sendToBot(bot.id, "Now the outro.");
    const next = yield* nextTurn(bot.id, turnId);

    // The engine says it after all: the agent had read the steer.
    yield* withheld.release;
    yield* deliveryIs(steer, "delivered");
    assert.deepStrictEqual(yield* admittedTurn(bot.id), Option.some(next));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels a message whose send was lost behind a turn when Stop races it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* control.loseNextReply;
    const message = yield* sendToBot(bot.id, "Rewrite the intro.");
    yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    yield* stops.stopBot({ commandId: command(), botId: bot.id });

    // The engine had queued it: Stop cancels it there, and the server learns so from events.
    yield* deliveryIs(message, "cancelled");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Rewrite the intro."), 1);

    // Once the Stop is confirmed the bot takes work again.
    const after = yield* sendToBot(bot.id, "Now the outro.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a Stop left unconfirmed by a restart before anything new reaches the session",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const firstRun = Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        const session = yield* engineSession(bot.id);
        const first = yield* sendToBot(bot.id, "Start the migration.");
        const running = yield* nextTurn(bot.id);
        yield* deliveryIs(first, "delivered");

        // The engine goes away before the Stop reaches it, and the operator writes again.
        yield* control.setReachable(false);
        yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
        const next = yield* sendToBot(bot.id, "Then roll it back.");
        yield* flushed(bot.id);
        return { bot, session, running, next };
      });
      const { bot, session, running, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

      yield* control.setReachable(true);
      yield* Effect.gen(function* () {
        // Had the new message gone first, it would have steered the turn the Stop ends.
        const started = yield* nextTurn(bot.id, running);
        yield* deliveryIs(next, "delivered");
        const received = yield* control.dispatches(session);
        const sent = received.filter((dispatch) => dispatch.text.includes("Then roll it back."));
        assert.deepStrictEqual(
          sent.map((dispatch) => dispatch.delivery),
          [{ _tag: "start", freshContext: false }],
        );
        yield* control.finishTurn({
          sessionId: session,
          turnId: started,
          outcome: { _tag: "completed" },
        });
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/** What the engine received carrying `text`, as the server sent it. */
const deliveriesOf = (session: SessionId, text: string) =>
  Effect.gen(function* () {
    const received = yield* (yield* TestEngineControl).dispatches(session);
    return received
      .filter((dispatch) => dispatch.text.includes(text))
      .map((dispatch) => dispatch.delivery._tag);
  });

it.effect(
  "confirms a Stop from the events after its acknowledgment, not from the acknowledgment",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const firstRun = Effect.gen(function* () {
        const bot = yield* createBot("Ana");
        const session = yield* engineSession(bot.id);
        yield* sendToBot(bot.id, "Start the import.");
        const running = yield* nextTurn(bot.id);

        // The Stop cannot reach the engine, and the turn ends on its own.
        yield* control.setReachable(false);
        yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
        yield* control.finishTurn({
          sessionId: session,
          turnId: running,
          outcome: { _tag: "completed" },
        });
        yield* turnEnded(bot.id);
        const next = yield* sendToBot(bot.id, "Then check the totals.");
        yield* flushed(bot.id);
        return { bot, session, next };
      });
      const { bot, session, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

      // While the server is down, background work starts a turn the server has
      // not seen; when the Stop arrives its interrupt is slow.
      yield* control.setReachable(true);
      const background = yield* control.startEngineTurn(session);
      yield* control.delayNextStopEffects;

      yield* Effect.gen(function* () {
        const started = yield* nextTurn(bot.id, background);
        yield* deliveryIs(next, "delivered");
        // Confirming on the acknowledgment would have steered it into the
        // background turn the Stop was still ending.
        assert.deepStrictEqual(yield* deliveriesOf(session, "Then check the totals."), ["start"]);
        yield* control.finishTurn({
          sessionId: session,
          turnId: started,
          outcome: { _tag: "completed" },
        });
        yield* turnEnded(bot.id);
        yield* gateSettled(bot.id);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("sends the latest round of a Stop again after a restart, and confirms it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Build the index.");
      const running = yield* nextTurn(bot.id);
      const waiting = yield* control.startEngineTurn(session);

      // The first round is acknowledged, and its interrupt never comes.
      yield* control.delayNextStopEffects;
      const stops = yield* Stops;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* gateSettled(bot.id);
      yield* stops.runPending;

      // The turn ends on its own and the waiting one starts: a second round
      // is opened for it, which the engine, gone again, never receives.
      yield* control.setReachable(false);
      yield* control.finishTurn({
        sessionId: session,
        turnId: running,
        outcome: { _tag: "completed" },
      });
      yield* nextTurn(bot.id, running);
      const next = yield* sendToBot(bot.id, "Then rebuild the cache.");
      yield* flushed(bot.id);
      return { bot, session, waiting, next };
    });
    const { bot, session, waiting, next } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    yield* control.setReachable(true);
    yield* Effect.gen(function* () {
      const started = yield* nextTurn(bot.id, waiting);
      yield* deliveryIs(next, "delivered");
      assert.deepStrictEqual(yield* deliveriesOf(session, "Then rebuild the cache."), ["start"]);
      yield* control.finishTurn({
        sessionId: session,
        turnId: started,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
      yield* gateSettled(bot.id);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("ends a room's turn waiting behind a private one only once the private one ended", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // Background work starts a private turn while the room's message is on
    // its way: the engine queues the room's turn behind it.
    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* sendInRoom(bot.id, room.id, "Plan the launch.");
    const background = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });
    // The engine's stop would end the whole session: the room's Stop sends
    // nothing while the private turn runs, and the operator's word reaches
    // that turn meanwhile.
    const meanwhile = yield* sendToBot(bot.id, "What is left today?");
    yield* until(
      Effect.map(deliveriesOf(session, "What is left today?"), (sent) => sent.length > 0),
    );
    assert.deepStrictEqual(yield* deliveriesOf(session, "What is left today?"), ["steer"]);
    yield* (yield* Stops).runPending;
    const issued = sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets WHERE issued_at IS NOT NULL
      `.pipe(Effect.orDie);
    assert.deepStrictEqual(yield* issued, [{ n: 0 }]);
    assert.deepStrictEqual(yield* admittedTurn(bot.id), Option.some(background));

    // The turn takes it and ends: the room's turn the engine starts next is
    // stopped, with nothing in the room's name to show.
    yield* control.readSteers({ sessionId: session, turnId: background });
    yield* control.finishTurn({
      sessionId: session,
      turnId: background,
      outcome: { _tag: "completed" },
    });
    yield* deliveryIs(meanwhile, "delivered");
    yield* stopSettled;
    yield* turnEnded(bot.id);
    const roomTurns = yield* sql<{ readonly outcome: string }>`
        SELECT json_extract(outcome_json, '$._tag') AS outcome FROM turns
        WHERE audience_room_id = ${room.id}
      `.pipe(Effect.orDie);
    assert.deepStrictEqual(roomTurns, [{ outcome: "interrupted" }]);
    assert.notInclude(yield* noticesOf(bot.id), "turn-failed");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "confirms a Stop of an idle session only once the background work it interrupts ended",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const stops = yield* Stops;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Watch the build.");
      const watching = yield* nextTurn(bot.id);
      yield* control.startBackgroundWork({ sessionId: session, turnId: watching });
      yield* control.finishTurn({
        sessionId: session,
        turnId: watching,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);

      // The engine takes the Stop, and its interrupt of the work the ended turn
      // left running is slow: the marker after the Stop still finds it running.
      const effects = yield* control.delayNextStopEffects;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* stops.runPending;
      const unsettled = sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM stop_targets WHERE sent_at IS NOT NULL AND stopped_at IS NULL
    `.pipe(Effect.orDie);
      assert.deepStrictEqual(yield* unsettled, [{ n: 1 }]);
      const after = yield* sendToBot(bot.id, "Then tag the release.");
      yield* stops.runPending;
      assert.deepStrictEqual(yield* unsettled, [{ n: 1 }]);
      assert.isTrue(yield* control.backgroundWorkRunning(session));

      // Once the work ended, the next pass confirms the Stop, and what waited goes.
      yield* effects.release;
      yield* TestClock.adjust(RETRY_TICK);
      yield* stopSettled;
      yield* nextTurn(bot.id, watching);
      yield* deliveryIs(after, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops a run that starts while the Stop's commands are on their way", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Index the repository.");
    yield* nextTurn(bot.id);

    // The Stop ends the turn, and background work creates another before the
    // engine answers. Its provider is slow to start it: at the marker after
    // the Stop it is still starting, and no event has told of it.
    const startup = yield* control.holdNextStartup(session);
    const during = yield* control.startEngineTurnDuringNextStop(session);
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    const slipped = yield* during.started;
    yield* during.reply;
    yield* stops.runPending;
    const unsettled = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM stop_targets WHERE sent_at IS NOT NULL AND stopped_at IS NULL
    `;
    assert.deepStrictEqual(unsettled, [{ n: 1 }]);
    yield* startup.release;
    yield* until(admittedTurn(bot.id).pipe(Effect.map(Option.contains(slipped))));

    // The round missed that run, so another round stops it.
    yield* turnEnded(bot.id);
    const after = yield* sendToBot(bot.id, "Then summarize it.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then summarize it."), ["start"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a fresh round after the engine refused a Stop while its work still runs", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Watch the build.");
    const watching = yield* nextTurn(bot.id);
    yield* control.startBackgroundWork({ sessionId: session, turnId: watching });
    yield* control.finishTurn({
      sessionId: session,
      turnId: watching,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);

    // The engine refuses the Stop, as when a read fails while it plans it,
    // and the work the ended turn left keeps running.
    yield* control.rejectNextStop;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    const after = yield* sendToBot(bot.id, "Then tag the release.");
    yield* stops.runPending;
    assert.isTrue(yield* control.backgroundWorkRunning(session));
    yield* deliveryIs(after, "pending");

    // Once its backoff passed, a fresh round stops the work. The engine
    // interrupts it after it answered, so a later pass confirms the Stop, and
    // what waited goes.
    yield* TestClock.adjust(RETRY_TICK);
    yield* until(control.backgroundWorkRunning(session).pipe(Effect.map((running) => !running)));
    yield* TestClock.adjust(RETRY_TICK);
    yield* stopSettled;
    yield* nextTurn(bot.id, watching);
    yield* deliveryIs(after, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops a fenced key that lands in the queue after the Stop's cancels", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // A message whose recovery gives up: its key may still land.
    const late = yield* control.deferNextDispatch;
    const message = yield* sendToBot(bot.id, "Rotate the keys.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(message, "failed");

    // A turn runs, with another waiting behind it, when the Stop is sent. Its
    // interrupt is slow, and its cancels name only the turn waiting then.
    yield* sendToBot(bot.id, "Draft the changelog.");
    yield* nextTurn(bot.id);
    yield* control.startEngineTurn(session);
    const effects = yield* control.delayNextStopEffects;
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* until(
      Effect.map(
        (yield* SqlClient.SqlClient)<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM stop_targets WHERE sent_at IS NOT NULL
        `,
        ([row]) => (row?.n ?? 0) > 0,
      ),
    );

    // The key lands behind the running turn, after the cancels were sent:
    // the round missed it, and the queue the Stop leaves holds it.
    yield* late.land;
    yield* deliveryIs(message, "pending");
    yield* effects.release;

    yield* stopSettled;
    yield* turnEnded(bot.id);
    yield* deliveryIs(message, "cancelled");
    const after = yield* sendToBot(bot.id, "Then rotate the certificates.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.strictEqual(yield* timesSent(session, "Rotate the keys."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a Stop again after its call timed out, with nothing else to wake it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Crawl the site.");
    yield* nextTurn(bot.id);

    // The engine takes the Stop but its answer is lost, and its interrupt
    // lags: no event follows that could nudge the runner.
    const effects = yield* control.delayNextStopEffects;
    const first = yield* control.holdNext("stop");
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* first.entered;
    yield* control.loseNextReply;
    yield* first.release;
    yield* gateSettled(bot.id);

    // A few seconds later the runner sends it again on its own.
    const again = yield* control.holdNext("stop");
    yield* TestClock.adjust(RETRY_TICK);
    yield* again.entered;
    yield* again.release;

    yield* effects.release;
    yield* turnEnded(bot.id);
    const after = yield* sendToBot(bot.id, "Then list the broken links.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then list the broken links."), ["start"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "confirms a reopened Stop once the recovery fails a later message's undecided send, which stays retryable",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      yield* engineSession(bot.id);

      // A Stop fences a message whose send stays undecided, and confirms once
      // the recovery gives up on it.
      const fenced = yield* control.deferNextDispatch;
      const stopped = yield* sendToBot(bot.id, "Rotate the keys.");
      yield* flushed(bot.id);
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(stopped, "cancelled");
      yield* stopSettled;

      // The next message's send is undecided too, and is no Stop's.
      yield* control.deferNextDispatch;
      const unfenced = yield* sendToBot(bot.id, "Then rotate the certificates.");
      yield* flushed(bot.id);

      // The fenced key lands after all, which reopens the Stop. The Stop
      // waits on the undecided send, which the recovery still settles. The
      // operator wrote that message after the Stop: it is new intent, so it
      // fails as never known, for the operator to send again.
      yield* fenced.land;
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(unfenced, "failed");
      const found = Option.getOrThrow(yield* (yield* Entries).find(unfenced)).entry;
      assert.deepStrictEqual(found._tag === "message" ? found.delivery : null, {
        _tag: "failed",
        reason: "unresolved",
      });
      yield* turnEnded(bot.id);
      yield* stopSettled;
      yield* deliveryIs(stopped, "cancelled");
      // Its turn never ran, so no turn failed: the message shows the failure.
      assert.notInclude(yield* noticesOf(bot.id), "turn-failed");

      yield* (yield* Pipeline).retryMessage({ commandId: command(), entryId: unfenced });
      yield* nextTurn(bot.id);
      yield* deliveryIs(unfenced, "delivered");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives up waiting on a marker that never comes, and confirms the Stop on a later pass",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const stops = yield* Stops;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Render the video.");
      yield* nextTurn(bot.id);

      // The Stop is acknowledged and ends the turn, and the marker that would
      // let it be confirmed is lost.
      const dropped = yield* control.dropNextMarker;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* dropped.requested;
      yield* turnEnded(bot.id);

      // The wait is bounded: past it, the next pass observes the session again.
      yield* TestClock.adjust(SYNC_DEADLINE);
      yield* stops.runPending;
      const after = yield* sendToBot(bot.id, "Then export the audio.");
      yield* nextTurn(bot.id);
      yield* deliveryIs(after, "delivered");
      assert.deepStrictEqual(yield* deliveriesOf(session, "Then export the audio."), ["start"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts no turn of its own for work a Stop covered that ended before the interrupt", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Index the archive.");
    const running = yield* nextTurn(bot.id);

    // The turn completes without a reply before the Stop's interrupt lands.
    const effects = yield* control.delayNextStopEffects;
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* control.finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* effects.release;
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets WHERE stopped_at IS NULL
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) === 0),
      ),
    );
    yield* flushed(bot.id);

    assert.strictEqual((yield* received(session)).length, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "settles a Stop when its session is lost with a queued start the engine acknowledged",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const stops = yield* Stops;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);

      // The engine queues the start behind a turn of its own, and says so.
      yield* control.startEngineTurnDuringNextDispatch(session);
      const message = yield* sendToBot(bot.id, "Rewrite the intro.");
      yield* nextTurn(bot.id);
      yield* gateSettled(bot.id);
      const [queued] = yield* sql<{ readonly status: string; readonly disposition: string | null }>`
      SELECT status, disposition FROM dispatches
      WHERE id = (SELECT dispatch_id FROM wakes WHERE source_entry_id = ${message})
    `;
      assert.deepStrictEqual(queued, { status: "accepted", disposition: "queued" });

      // The Stop is acknowledged and its effects never land; then the engine
      // loses the session.
      yield* control.delayNextStopEffects;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* stops.runPending;
      yield* control.loseSession(session);

      yield* stopSettled;
      yield* deliveryIs(message, "cancelled");
      assert.deepStrictEqual(yield* noticesOf(bot.id), ["session-lost"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels a private message a bot Stop dropped after the room's archival", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // A room message whose recovery gave up: its key may still land, so the
    // room's archival stops the session too.
    yield* control.deferNextDispatch;
    const inRoom = yield* sendInRoom(bot.id, room.id, "Tag the release.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(inRoom, "failed");

    // A private message waits in the engine behind a turn of the engine's own.
    yield* control.startEngineTurnDuringNextDispatch(session);
    const message = yield* sendToBot(bot.id, "What is left today?");
    yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // The operator stops the bot, whose interrupt is slow, then archives the
    // room, whose Stop waits for the private turn; the bot's Stop then drops
    // the waiting turn.
    const slow = yield* control.delayNextStopEffects;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });
    yield* slow.release;

    // The operator stopped it: cancelled, not failed and offered again.
    yield* deliveryIs(message, "cancelled");
    yield* turnEnded(bot.id);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("names a room's Stop on the retryable notice of an answer it dropped", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const asking = yield* nextTurn(bot.id);
    const card = yield* askRegion(bot.id, session, asking);
    yield* control.finishTurn({
      sessionId: session,
      turnId: asking,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);

    // The room's turn leaves background work, which wakes the session with a
    // turn of the room's while the answer is on its way: the answer waits in
    // the engine behind it.
    yield* sendInRoom(bot.id, room.id, "Watch the build.");
    const watching = yield* nextTurn(bot.id, asking);
    yield* control.startBackgroundWork({ sessionId: session, turnId: watching });
    yield* control.finishTurn({
      sessionId: session,
      turnId: watching,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* control.startEngineTurnDuringNextDispatch(session, watching);
    yield* answerFirstOption(card);
    yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // The room's Stop drops the answer: no Stop of the bot's own work covers it.
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });

    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "stopped" });
    assert.isTrue(notice.retryable);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** How the wakes written for a room ended, also once the room is gone. */
const roomWakes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly status: string }>`
    SELECT status FROM wakes WHERE audience = 'room' ORDER BY rowid
  `;
  return rows.map((row) => row.status);
});

it.effect("cancels a deleted room's message that waited in the engine", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // The room's turn waits in the engine behind one its background work
    // started.
    yield* sendInRoom(bot.id, room.id, "Watch the build.");
    const watching = yield* nextTurn(bot.id);
    yield* control.startBackgroundWork({ sessionId: session, turnId: watching });
    yield* control.finishTurn({
      sessionId: session,
      turnId: watching,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* control.startEngineTurnDuringNextDispatch(session, watching);
    yield* sendInRoom(bot.id, room.id, "Plan the launch.");
    yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // The room's Stop drops it after the room is gone: the operator stopped it.
    yield* (yield* Rooms).remove({ commandId: command(), roomId: room.id });
    yield* stopSettled;
    assert.deepStrictEqual(yield* roomWakes, ["finished", "cancelled"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops a deleted room's message whose key lands after the room is gone", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // The room is deleted while the send of its message is undecided, and
    // the recovery then gives up: its key may still land.
    const late = yield* control.deferNextDispatch;
    yield* sendInRoom(bot.id, room.id, "Tag the release.");
    yield* flushed(bot.id);
    yield* (yield* Rooms).remove({ commandId: command(), roomId: room.id });
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* stopSettled;
    assert.deepStrictEqual(yield* roomWakes, ["cancelled"]);

    // It lands: its turn starts for a room that no longer exists, and the
    // Stop it reopens ends it. The operator stopped it, so it stays cancelled.
    yield* late.land;
    yield* until(
      Effect.map(
        (yield* SqlClient.SqlClient)<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM turns WHERE finished_at IS NOT NULL
        `,
        ([row]) => (row?.n ?? 0) > 0,
      ),
    );
    yield* stopSettled;
    assert.deepStrictEqual(yield* roomWakes, ["cancelled"]);
    assert.notInclude(yield* noticesOf(bot.id), "turn-failed");
    assert.strictEqual(yield* timesSent(session, "Tag the release."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows no retryable notice for an answer whose session is lost during a Stop", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const asking = yield* nextTurn(bot.id);
    const card = yield* askRegion(bot.id, session, asking);
    yield* control.finishTurn({
      sessionId: session,
      turnId: asking,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);

    // The answer waits in the engine behind a turn of its own, and the
    // recovery learns the engine has it.
    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* control.loseNextReply;
    yield* answerFirstOption(card);
    yield* nextTurn(bot.id, asking);
    yield* gateSettled(bot.id);
    yield* recoverTimes(1);

    // The operator stops the bot, and the session is lost before the
    // interrupt lands.
    yield* control.delayNextStopEffects;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    yield* control.loseSession(session);

    yield* stopSettled;
    yield* until(noticesOf(bot.id).pipe(Effect.map((kinds) => kinds.includes("session-lost"))));
    assert.deepStrictEqual(yield* noticesOf(bot.id), ["session-lost"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a Stop's round once an undecided steer is resent into an unobservable session",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const sql = yield* SqlClient.SqlClient;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Review the PR.");
      const turnId = yield* nextTurn(bot.id);

      // A steer the engine took, whose reply was lost.
      const sending = yield* control.holdNext("dispatch");
      yield* sendToBot(bot.id, "Also check the tests.");
      yield* sending.entered;
      yield* control.loseNextReply;
      yield* sending.release;
      yield* gateSettled(bot.id);

      // An event of the session cannot be applied: what the server knows of
      // it is behind, and it is not ready.
      yield* sql`
      CREATE TRIGGER poison BEFORE INSERT ON work_steps BEGIN SELECT RAISE(ABORT, 'poison'); END
    `;
      yield* control.step({
        sessionId: session,
        turnId,
        step: {
          id: WorkStepId.make("step-1"),
          kind: "command",
          tool: null,
          label: "npm test",
          status: "running",
          startedAt: yield* DateTime.now,
          finishedAt: null,
        },
      });
      yield* awaitEntry(bot.id, "notice");

      // The Stop waits on the steer, whose resend needs no observation: its
      // key answers for it. Then the round goes out.
      const round = yield* control.holdNext("stop");
      yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
      yield* round.entered;
      yield* round.release;
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** Rounds the engine acknowledged whose target has not settled. */
const acknowledgedUnsettled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM stop_targets WHERE sent_at IS NOT NULL AND stopped_at IS NULL
  `.pipe(Effect.orDie);
  return row?.n ?? 0;
});

it.effect("sends a fresh round for a run whose provider never starts it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Index the repository.");
    yield* nextTurn(bot.id);

    // Background work creates a run while the Stop's commands are on their
    // way, and its provider never starts it: no event will tell of it.
    yield* control.holdNextStartup(session);
    const during = yield* control.startEngineTurnDuringNextStop(session);
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* during.started;
    yield* during.reply;
    yield* stops.runPending;
    assert.strictEqual(yield* acknowledgedUnsettled, 1);

    // Past the round's grace the engine still lists the run as starting: a
    // fresh round stops it, and what waited goes.
    yield* TestClock.adjust(stopGrace(1));
    yield* stopSettled;
    const after = yield* sendToBot(bot.id, "Then summarize it.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then summarize it."), ["start"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a fresh round when the engine acknowledged a Stop whose interrupt it lost", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Crawl the site.");
    const running = yield* nextTurn(bot.id);

    // The engine acknowledges the Stop and its interrupt never lands, as when
    // planning it failed: the turn keeps running.
    yield* control.delayNextStopEffects;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    assert.strictEqual(yield* acknowledgedUnsettled, 1);
    assert.isTrue(Option.contains(yield* admittedTurn(bot.id), running));

    // Past the round's grace the turn still runs: a fresh round ends it.
    yield* TestClock.adjust(stopGrace(1));
    yield* turnEnded(bot.id);
    yield* stopSettled;
    const after = yield* sendToBot(bot.id, "Then list the broken links.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then list the broken links."), ["start"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a fresh round after a restart once an acknowledged round's grace passed", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Render the video.");
      yield* nextTurn(bot.id);

      // The Stop is acknowledged, its interrupt is lost, and the server stops.
      yield* control.delayNextStopEffects;
      const stops = yield* Stops;
      yield* stops.stopBot({ commandId: command(), botId: bot.id });
      yield* stops.runPending;
      assert.strictEqual(yield* acknowledgedUnsettled, 1);
      return { bot, session };
    });
    const { bot, session } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    // The grace is the round's own: it passed while the server was down.
    yield* TestClock.adjust(stopGrace(1));
    yield* Effect.gen(function* () {
      yield* turnEnded(bot.id);
      yield* stopSettled;
      const after = yield* sendToBot(bot.id, "Then export the audio.");
      const started = yield* nextTurn(bot.id);
      yield* deliveryIs(after, "delivered");
      assert.deepStrictEqual(yield* deliveriesOf(session, "Then export the audio."), ["start"]);
      yield* control.finishTurn({
        sessionId: session,
        turnId: started,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/** Starts a turn that leaves background work running, and ends it. */
const leaveBackgroundWork = Effect.fn(function* (botId: BotId, session: SessionId) {
  const control = yield* TestEngineControl;
  const watching = yield* nextTurn(botId);
  yield* control.startBackgroundWork({ sessionId: session, turnId: watching });
  yield* control.finishTurn({
    sessionId: session,
    turnId: watching,
    outcome: { _tag: "completed" },
  });
  yield* turnEnded(botId);
  return watching;
});

it.effect("sends the operator's new Stop while an older round backs off", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Watch the build.");
    const watching = yield* leaveBackgroundWork(bot.id, session);

    // The engine refuses the first Stop: its next round waits out a backoff.
    yield* control.rejectNextStop;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;

    // The operator stops the bot again: that round is due at once, and goes.
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    const [newest] = yield* sql<{ readonly sent: number }>`
      SELECT t.sent_at IS NOT NULL AS sent FROM stop_targets t
      WHERE t.stop_id = (SELECT id FROM stops ORDER BY rowid DESC LIMIT 1)
    `;
    assert.deepStrictEqual(newest, { sent: 1 });

    // The older round goes once its backoff passed, and the Stops settle.
    const after = yield* sendToBot(bot.id, "Then tag the release.");
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* stopSettled;
    yield* nextTurn(bot.id, watching);
    yield* deliveryIs(after, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("settles a Stop whose session is lost after the engine refused a round", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Watch the build.");
    yield* leaveBackgroundWork(bot.id, session);

    yield* control.rejectNextStop;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    yield* control.loseSession(session);

    yield* stopSettled;
    yield* until(noticesOf(bot.id).pipe(Effect.map((kinds) => kinds.includes("session-lost"))));
    // The refused round keeps the engine's answer.
    const [refused] = yield* sql<{ readonly refused: number; readonly sent: number }>`
      SELECT rejected_at IS NOT NULL AS refused, sent_at IS NOT NULL AS sent
      FROM stop_targets WHERE round = 0
    `;
    assert.deepStrictEqual(refused, { refused: 1, sent: 0 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

// A scheduled task's message, which the engine queues on its own and no
// dispatch of the server's names (**Read** at `db51b67`,
// `ScheduledTaskService.ts`, L1062-1090).
it.effect("stops a run the engine queues on its own after the Stop's cancels", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Index the repository.");
    const indexing = yield* nextTurn(bot.id);

    // The engine takes the Stop with nothing waiting, and before its effects
    // land, a run of its own queues behind the turn: the round's cancels miss
    // it, and the Stop's hold keeps it waiting.
    const effects = yield* control.delayNextStopEffects;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    const scheduled = yield* control.startEngineTurn(session);
    yield* effects.release;
    yield* turnEnded(bot.id);
    yield* stops.runPending;
    const unsettled = sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM stop_targets WHERE stopped_at IS NULL
    `.pipe(Effect.orDie);
    assert.deepStrictEqual(yield* unsettled, [{ n: 1 }]);

    // Once the round's grace passed, a fresh round cancels it, and the Stop settles.
    yield* TestClock.adjust(stopGrace(1));
    yield* until(
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets WHERE round = 1 AND sent_at IS NOT NULL
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.n === 1),
      ),
    );
    yield* TestClock.adjust(RETRY_TICK);
    yield* stopSettled;
    const after = yield* sendToBot(bot.id, "Then summarize it.");
    const started = yield* nextTurn(bot.id, indexing);
    assert.notStrictEqual(started, scheduled);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then summarize it."), ["start"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("opens no round for a refusal its session's loss overtook", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Watch the build.");
    yield* leaveBackgroundWork(bot.id, session);

    // The engine refuses the round, and the session is lost before the runner
    // hears the refusal.
    yield* control.rejectNextStop;
    const answer = yield* control.holdNextAnswer("stop");
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* answer.entered;
    yield* control.loseSession(session);
    yield* until(
      sql<{ readonly lost: number }>`
        SELECT lost_at IS NOT NULL AS lost FROM sessions WHERE engine_session_id = ${session}
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.lost === 1),
      ),
    );
    yield* answer.release;

    // The round keeps the engine's answer, and the target stays settled.
    const rounds = sql<{
      readonly round: number;
      readonly refused: number;
      readonly settled: number;
    }>`
      SELECT round, rejected_at IS NOT NULL AS refused, stopped_at IS NOT NULL AS settled
      FROM stop_targets ORDER BY round
    `.pipe(Effect.orDie);
    yield* until(Effect.map(rounds, ([first]) => first?.refused === 1));
    assert.deepStrictEqual(yield* rounds, [{ round: 0, refused: 1, settled: 1 }]);
  }).pipe(Effect.provide(TestDomain.layer)),
);
