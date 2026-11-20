// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, EntryTarget } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Entries } from "../entries/Entries.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  gateSettled,
  nextTurn,
  sendToBot,
  timesSent,
  until,
} from "../testing/turns.ts";
import { recoveryBackoff } from "./model.ts";
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
          ...wake({ _tag: "undelivered", dispatchId: "earlier" }),
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
