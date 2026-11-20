// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, EntryTarget } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { BotTools } from "../tools/BotTools.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  answerFirstOption,
  askRegion,
  awaitEntry,
  command,
  concurrentTurns,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  gateSettled,
  holdGate,
  nextTurn,
  recoverTimes,
  sendToBot,
  sendWithFile,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { Cards } from "./Cards.ts";
import { busyBackoff, DispatchRowId, MAX_INDETERMINATE_ANSWERS, recoveryBackoff } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Wakes } from "./Wakes.ts";

it.effect("delivers a message once when its send's reply is lost while the session is busy", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // The engine applies the start behind a turn of its own, and the answer is lost.
    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* control.loseNextReply;
    const message = yield* sendToBot(bot.id, "Ship the report.");
    const ownTurn = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // Recovery resends the same key once its backoff passes.
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* pipeline.recoverDue;
    yield* control.finishTurn({
      sessionId: session,
      turnId: ownTurn,
      outcome: { _tag: "completed" },
    });

    const delivered = yield* nextTurn(bot.id, ownTurn);
    yield* deliveryIs(message, "delivered");
    yield* control.finishTurn({
      sessionId: session,
      turnId: delivered,
      outcome: { _tag: "completed" },
    });
    yield* flushed(bot.id);

    assert.strictEqual(yield* timesSent(session, "Ship the report."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** An operator message written without waking anyone, for a test to wake the bot itself. */
const writeMessage = (target: EntryTarget, text: string) =>
  Effect.gen(function* () {
    const entry = yield* (yield* Entries).append({
      target,
      entry: {
        _tag: "message",
        author: { _tag: "operator" },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "pending" },
        commandId: null,
      },
    });
    return entry.id;
  });

const finishRunning = (botId: BotId, previous: Parameters<typeof nextTurn>[1] = null) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const session = yield* engineSession(botId);
    const turnId = yield* nextTurn(botId, previous);
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    return turnId;
  });

it.effect("coalesces waiting wakes only with wakes of the same kind and audience", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const wakes = yield* Wakes;
    const bot = yield* createBot("Ana");
    const other = yield* createBot("Bia");
    const session = yield* engineSession(bot.id);
    const room = yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [bot.id, other.id],
      hostId: bot.id,
    });
    const inConversation = { _tag: "conversation", botId: bot.id } as const;
    const first = yield* writeMessage(inConversation, "First in private.");
    const inRoom = yield* writeMessage({ _tag: "room", roomId: room.id }, "Said in the room.");
    const second = yield* writeMessage(inConversation, "Second in private.");

    const wake = (payload: Parameters<typeof wakes.record>[0][number]["payload"]) => ({
      botId: bot.id,
      sourceEntryId: null,
      hops: 0,
      retryOf: null,
      cause: { _tag: "operator" } as const,
      payload,
    });
    yield* sql.withTransaction(
      wakes.record([
        {
          ...wake({ _tag: "message", entryId: first }),
          kind: "user",
          audience: { _tag: "conversation" },
        },
        {
          ...wake({ _tag: "undelivered", dispatchId: DispatchRowId.make("earlier") }),
          kind: "system",
          audience: { _tag: "conversation" },
        },
        {
          ...wake({ _tag: "message", entryId: inRoom }),
          kind: "user",
          audience: { _tag: "room", roomId: room.id },
        },
        {
          ...wake({ _tag: "message", entryId: second }),
          kind: "user",
          audience: { _tag: "conversation" },
        },
      ]),
    );

    const one = yield* finishRunning(bot.id);
    const two = yield* finishRunning(bot.id, one);
    yield* finishRunning(bot.id, two);
    yield* until(control.dispatches(session).pipe(Effect.map((all) => all.length === 3)));

    const [private_, room_, system] = yield* control.dispatches(session);
    assert.include(private_?.text, "First in private.");
    assert.include(private_?.text, "Second in private.");
    // In the order the operator wrote them, though written in one transaction.
    assert.isBelow(
      private_?.text.indexOf("First in private.") ?? -1,
      private_?.text.indexOf("Second in private.") ?? -1,
    );
    assert.notInclude(private_?.text, "Said in the room.");
    assert.include(room_?.text, "Said in the room.");
    assert.notInclude(room_?.text, "in private.");
    assert.notInclude(system?.text, "in private.");
    assert.notInclude(system?.text, "Said in the room.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a refused message failed until the operator retries it, then delivers it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    yield* control.rejectNextDispatch;
    const message = yield* sendToBot(bot.id, "Draft the plan.");
    yield* deliveryIs(message, "failed");
    yield* gateSettled(bot.id);
    assert.strictEqual(yield* timesSent(session, "Draft the plan."), 0);

    yield* pipeline.retryMessage({ commandId: command(), entryId: message });
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Draft the plan."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to send a message again once the engine accepted it late", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    // The message's send is never answered, and its recovery gives up.
    const { session, deferred, message } = yield* Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const deferred = yield* control.deferNextDispatch;
      const message = yield* sendToBot(bot.id, "Ship the report.");
      yield* flushed(bot.id);
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(message, "failed");
      return { session, deferred, message };
    }).pipe(Effect.provide(Domain.layer));

    // While the server is down the engine applies it after all, behind a turn
    // of its own, and forgets the history the server's cursor names: the
    // replacement shows it waiting, accepted.
    yield* control.startEngineTurn(session);
    yield* deferred.land;
    yield* control.pruneHistory(session);

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* until(
        sql<{ readonly status: string }>`SELECT status FROM dispatches`.pipe(
          Effect.orDie,
          Effect.map(([row]) => row?.status === "accepted"),
        ),
      );
      const refused = yield* (yield* Pipeline)
        .retryMessage({ commandId: command(), entryId: message })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "Conflict");
      yield* deliveryIs(message, "pending");
      assert.strictEqual(yield* timesSent(session, "Ship the report."), 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("holds an answer until the turn that asked ends, then starts a turn with it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const turnId = yield* nextTurn(bot.id);
    const args = { prompt: "Which region?", options: [{ label: "Europe", value: "eu-west-1" }] };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: session,
      tool: "ask",
      arguments: args,
    });
    const card = yield* awaitEntry(bot.id, "question");

    // The operator answers before the bot ends the turn that asked.
    yield* (yield* Cards).answer({
      commandId: command(),
      entryId: card.id,
      answer: {
        _tag: "question",
        answers: { [card.questions[0].id]: { optionIds: ["option-1"], text: null } },
      },
    });
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 0);

    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* nextTurn(bot.id, turnId);
    const answered = (yield* control.dispatches(session)).filter((dispatch) =>
      dispatch.text.includes("eu-west-1"),
    );
    assert.deepStrictEqual(
      answered.map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows a retryable notice for an answer whose dispatch failed, and sends it on retry",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Deploy it.");
      const turnId = yield* nextTurn(bot.id);
      const args = { prompt: "Which region?", options: [{ label: "Europe", value: "eu-west-1" }] };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "ask",
        input: args,
        recorded: "now",
      });
      yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: session,
        tool: "ask",
        arguments: args,
      });
      const card = yield* awaitEntry(bot.id, "question");
      yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
      yield* turnEnded(bot.id);

      // The engine refuses the turn the answer starts.
      yield* control.rejectNextDispatch;
      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: {
          _tag: "question",
          answers: { [card.questions[0].id]: { optionIds: ["option-1"], text: null } },
        },
      });
      const notice = yield* awaitEntry(bot.id, "notice");
      assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "unknown" });
      assert.isTrue(notice.retryable);

      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
      yield* nextTurn(bot.id, turnId);
      assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a failed turn's message again when the operator retries its notice", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Compile the report.");
    const turnId = yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "provider-error" });

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, turnId);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Compile the report."), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends an engine card's answer again after a restart, once", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Clean the build folder.");
      const turnId = yield* nextTurn(bot.id);
      yield* control.openRequest({
        sessionId: session,
        turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action: "rm -rf build",
          detail: null,
          reason: null,
          exact: true,
          sessionGrant: null,
        },
      });
      const card = yield* awaitEntry(bot.id, "approval");
      // The answer is recorded, and the engine is gone before it is sent.
      yield* control.setReachable(false);
      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "approval", decision: "allow-once" },
      });
      return { bot, session };
    });
    const { bot, session } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    yield* control.setReachable(true);
    yield* Effect.gen(function* () {
      yield* until(
        awaitEntry(bot.id, "approval").pipe(Effect.map((card) => card.status._tag === "decided")),
      );
      assert.strictEqual((yield* control.responses(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("starts a bot refused busy once the deadline passes, after the turn's last event", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // The engine starts a turn of its own while the start is at its door, and
    // the refusal reaches the server only after that turn's last event.
    const sending = yield* control.holdNext("dispatch");
    const message = yield* sendToBot(bot.id, "Draft the summary.");
    yield* sending.entered;
    const background = yield* control.startEngineTurn(session);
    const answer = yield* control.holdNextAnswer("dispatch");
    yield* sending.release;
    yield* answer.entered;
    yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId: background,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* answer.release;
    yield* gateSettled(bot.id);

    // The session is left alone until its deadline, and taken after it.
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Draft the summary."), 0);
    yield* TestClock.adjust(busyBackoff(1));
    yield* flushed(bot.id);
    yield* nextTurn(bot.id, background);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Draft the summary."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts a ready bot with the last slot while another bot's session catches up", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* concurrentTurns(1);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);

    // Ana's session never answers with its first snapshot.
    const stalled = yield* control.withholdEvents(anaSession);
    const waiting = yield* sendToBot(ana.id, "Plan the sprint.");
    const message = yield* sendToBot(bia.id, "Review the budget.");
    yield* flushed(bia.id);
    const biaTurn = yield* nextTurn(bia.id);
    yield* deliveryIs(message, "delivered");

    // Once caught up, Ana takes the slot Bia gives back.
    yield* stalled.release;
    yield* flushed(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Plan the sprint."), 0);
    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* nextTurn(ana.id);
    yield* deliveryIs(waiting, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * Waits until a steer is written. Writing a dispatch changes nothing a client
 * sees, so this reads the table again each time other fibers have run.
 */
const steerWritten = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM dispatches WHERE delivery = 'steer'
    `.pipe(Effect.orDie);
    if ((row?.n ?? 0) > 0) return;
    yield* Effect.yieldNow;
  }
});

it.effect("starts a turn with a steer whose turn ended while it waited for the gate", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Collect the metrics.");
    const running = yield* nextTurn(bot.id);

    // The message is planned into the running turn, and its send waits.
    const gate = yield* holdGate(bot.id);
    const message = yield* sendToBot(bot.id, "Include last week too.");
    yield* steerWritten;
    yield* control.finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* gate.release;

    yield* nextTurn(bot.id, running);
    yield* deliveryIs(message, "delivered");
    const received = yield* control.dispatches(session);
    assert.deepStrictEqual(
      received
        .filter((dispatch) => dispatch.text.includes("Include last week too."))
        .map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("waits for a turn slot before sending a message whose file failed to stage", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    yield* concurrentTurns(1);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);

    // Ana's file is staged, and the reply is lost: nothing reached the engine.
    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(ana.id, "Read the notes.");
    yield* staging.entered;
    yield* control.loseNextReply;
    yield* staging.release;
    yield* gateSettled(ana.id);

    // Bia takes the only slot, and Ana's retry falls due.
    yield* sendToBot(bia.id, "Review the budget.");
    const biaTurn = yield* nextTurn(bia.id);
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* pipeline.recoverDue;
    yield* flushed(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 0);

    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bia.id);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves a start unsent when the budget is lowered while its file stages", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* concurrentTurns(2);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);
    yield* sendToBot(bia.id, "Review the budget.");
    const biaTurn = yield* nextTurn(bia.id);

    // Ana's start is planned with the second slot, and the operator lowers
    // the budget to one while its file stages.
    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(ana.id, "Read the notes.");
    yield* staging.entered;
    yield* concurrentTurns(1);
    yield* staging.release;
    yield* gateSettled(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 0);

    // It goes once Bia's turn frees the only slot.
    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bia.id);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a message whose file failed to stage with the slot its session's continuation holds",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      yield* concurrentTurns(1);
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Translate the docs.");
      const first = yield* nextTurn(bot.id);
      const resumesAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
      yield* control.finishTurn({
        sessionId: session,
        turnId: first,
        outcome: { _tag: "failed", failure: "usage-limit", retryAt: resumesAt },
        continuation: { resumesAt },
      });
      yield* turnEnded(bot.id);

      // The operator's message may start a turn on the slot the pending
      // continuation holds, and its file's staging reply is lost.
      const staging = yield* control.holdNext("stageAttachment");
      const message = yield* sendWithFile(bot.id, "Read the notes.");
      yield* staging.entered;
      yield* control.loseNextReply;
      yield* staging.release;
      yield* gateSettled(bot.id);

      // Staged again once the backoff passes, it is sent on that same slot.
      yield* TestClock.adjust(recoveryBackoff(1));
      yield* flushed(bot.id);
      yield* nextTurn(bot.id, first);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* timesSent(session, "Read the notes."), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends an answer again from its notice when its turn failed to start", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
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

    // The engine takes the answer, and its turn fails before the provider starts it.
    yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
    yield* answerFirstOption(card);
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(notice.retryable);

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, asking);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to send an answer again once the engine applied it late", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
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

    // The answer's send is never answered, and its recovery gives up.
    const deferred = yield* control.deferNextDispatch;
    yield* answerFirstOption(card);
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    const notice = yield* awaitEntry(bot.id, "notice");

    // Then the engine applies it after all.
    yield* deferred.land;
    yield* nextTurn(bot.id, asking);
    const refused = yield* (yield* Pipeline)
      .retryNotice({ commandId: command(), entryId: notice.id })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "Conflict");
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The bot asks in a turn that then ends, and the card it asked with. */
const askedAndEnded = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Deploy it.");
  const asking = yield* nextTurn(bot.id);
  const card = yield* askRegion(bot.id, session, asking);
  yield* control.finishTurn({ sessionId: session, turnId: asking, outcome: { _tag: "completed" } });
  yield* turnEnded(bot.id);
  return { bot, session, asking, card };
});

/** Waits until the engine's events settled the bot's only answer dispatch as dropped. */
const answerDropped = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
      WHERE d.status = 'dropped' AND json_extract(w.payload_json, '$._tag') = 'answer'
    `.pipe(Effect.orDie);
    if ((row?.n ?? 0) > 0) return;
    yield* Effect.yieldNow;
  }
});

it.effect("keeps an answer's notice retryable when the send's reply follows its failed start", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, session, asking, card } = yield* askedAndEnded;

    // The answer's turn fails before the provider starts it, and the events
    // say so before the send hears the engine took the key.
    yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
    const reply = yield* control.holdNextAnswer("dispatch");
    yield* answerFirstOption(card);
    yield* reply.entered;
    yield* awaitEntry(bot.id, "notice");
    yield* reply.release;
    yield* gateSettled(bot.id);

    const notice = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(notice.retryable);
    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, asking);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers an answer's retry again when the engine drops it after its recovery gave up",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, session, asking, card } = yield* askedAndEnded;

      // The answer's send is never answered, and its recovery gives up.
      const deferred = yield* control.deferNextDispatch;
      yield* answerFirstOption(card);
      yield* flushed(bot.id);
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* awaitEntry(bot.id, "notice");

      // The engine applies it after all, and its turn fails before it starts:
      // the bot never read the answer.
      yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
      yield* deferred.land;
      yield* answerDropped;

      const notice = yield* awaitEntry(bot.id, "notice");
      assert.isTrue(notice.retryable);
      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
      yield* nextTurn(bot.id, asking);
      assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
    }).pipe(Effect.provide(TestDomain.layer)),
);
