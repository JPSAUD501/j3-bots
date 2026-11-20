// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { WorkStepId } from "@j3-bots/contracts";
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
import { MAX_INDETERMINATE_ANSWERS, SYNC_DEADLINE } from "./model.ts";
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

it.effect("ends the private work in a session when its room is archived", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const room = yield* roomOf(bot.id);

    // Background work starts a private turn while the room's message is on
    // its way: the engine queues the room's turn behind it.
    yield* control.startEngineTurnDuringNextDispatch(session);
    const inRoom = yield* sendInRoom(bot.id, room.id, "Plan the launch.");
    const background = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });
    const meanwhile = yield* sendToBot(bot.id, "What is left today?");

    // The engine's Stop ends the whole session: the room's turn is cancelled
    // and the private turn is interrupted, and the private message goes after.
    yield* deliveryIs(inRoom, "cancelled");
    const started = yield* nextTurn(bot.id, background);
    yield* deliveryIs(meanwhile, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "What is left today?"), ["start"]);
    assert.isFalse(yield* control.backgroundWorkRunning(session));
    yield* control.finishTurn({
      sessionId: session,
      turnId: started,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
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
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Index the repository.");
    yield* nextTurn(bot.id);

    // The Stop ends the turn, and background work starts another before the
    // engine answers; the server sees that start before the acknowledgment.
    const during = yield* control.startEngineTurnDuringNextStop(session);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    const slipped = yield* during.started;
    yield* until(admittedTurn(bot.id).pipe(Effect.map(Option.contains(slipped))));
    yield* during.reply;

    // The round missed that run, so another round stops it.
    yield* turnEnded(bot.id);
    const after = yield* sendToBot(bot.id, "Then summarize it.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(after, "delivered");
    assert.deepStrictEqual(yield* deliveriesOf(session, "Then summarize it."), ["start"]);
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

    assert.strictEqual((yield* control.dispatches(session)).length, 1);
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
      SELECT status, disposition FROM dispatches WHERE bot_id = ${bot.id}
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
    // room, whose Stop drops the waiting turn.
    yield* control.delayNextStopEffects;
    yield* stops.stopBot({ commandId: command(), botId: bot.id });
    yield* stops.runPending;
    yield* (yield* Rooms).update({
      commandId: command(),
      roomId: room.id,
      changes: { archived: true },
    });

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

    // A room message whose recovery gave up: its key may still land, so the
    // room's archival stops the session too.
    yield* control.deferNextDispatch;
    const inRoom = yield* sendInRoom(bot.id, room.id, "Tag the release.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(inRoom, "failed");

    // The answer waits in the engine behind a turn of the engine's own, and
    // the room's Stop drops it: no Stop of the bot's own work covers it.
    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* answerFirstOption(card);
    yield* nextTurn(bot.id, asking);
    yield* gateSettled(bot.id);
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
