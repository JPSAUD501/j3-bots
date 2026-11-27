// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, Routine, type RoutineId, TimeZone } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Routines } from "../routines/Routines.ts";
import { Scheduler } from "../routines/Scheduler.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { eventArgumentsProblem } from "./routineTool.ts";

const decodeRoutine = Schema.decodeUnknownSync(Schema.toCodecJson(Routine));

/** The routine a call returned. */
const savedBy = (reply: ToolCallResponse) => {
  if (reply._tag !== "result") throw new Error(`Not a result: ${JSON.stringify(reply)}`);
  return decodeRoutine(reply.value);
};

/** The bot is working on a message from the operator, who keeps Tokyo time (UTC+9, no clock changes). */
const working = Effect.gen(function* () {
  yield* (yield* SettingsService).update({
    commandId: command(),
    changes: { timeZone: TimeZone.make("Asia/Tokyo") },
  });
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Remind me about the dentist.");
  const turnId = yield* nextTurn(bot.id);
  return { bot, session, turnId };
});

/** The bot calls `set_routine` in the turn, which the engine records first. */
const setRoutine = (
  sessionId: SessionId,
  turnId: TurnId,
  args: { readonly [key: string]: string | boolean },
  requestId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "set_routine",
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId,
      sessionId,
      tool: "set_routine",
      arguments: args,
    });
  });

it.effect(
  "creates the bot's routine with times in the operator's zone, once under a retried request",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId } = yield* working;
      const args = {
        action: "create",
        name: "Dentist",
        instruction: "Tell my user the dentist appointment is at 10:00 today.",
        at: "2030-03-04T09:00",
      };

      const reply = yield* setRoutine(session, turnId, args, "call-1");
      const created = savedBy(reply);
      assert.deepStrictEqual(created.trigger, {
        _tag: "once",
        at: DateTime.makeUnsafe("2030-03-04T00:00:00Z"),
      });
      assert.deepStrictEqual(created.nextRunAt, DateTime.makeUnsafe("2030-03-04T00:00:00Z"));

      // The bridge forwarding the request again gets the first result and acts no more.
      const repeated = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: session,
        tool: "set_routine",
        arguments: args,
      });
      assert.deepStrictEqual(repeated, reply);
      const routines = yield* (yield* Routines).list(bot.id);
      assert.deepStrictEqual(
        routines.map((routine) => routine.id),
        [created.id],
      );
      const changes = (yield* conversation(bot.id)).flatMap((entry) =>
        entry._tag === "routine-change" ? [[entry.author, entry.change]] : [],
      );
      assert.deepStrictEqual(changes, [[{ _tag: "bot", botId: bot.id }, "created"]]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("reads a new schedule in the operator's zone as set now, and keeps a saved one's", () =>
  Effect.gen(function* () {
    const { session, turnId } = yield* working;
    const created = savedBy(
      yield* setRoutine(
        session,
        turnId,
        {
          action: "create",
          name: "Standup",
          instruction: "Remind my user of the standup.",
          schedule: "30 8 * * 1-5",
        },
        "call-1",
      ),
    );
    assert.deepStrictEqual(created.trigger, {
      _tag: "schedule",
      cron: "30 8 * * 1-5",
      timeZone: "Asia/Tokyo",
    });
    yield* (yield* SettingsService).update({
      commandId: command(),
      changes: { timeZone: TimeZone.make("Europe/Lisbon") },
    });

    // A change with no new trigger keeps the zone the schedule was saved in.
    const renamed = savedBy(
      yield* setRoutine(
        session,
        turnId,
        { action: "update", id: created.id, name: "Daily standup" },
        "call-2",
      ),
    );
    assert.deepStrictEqual(renamed.trigger, created.trigger);

    // A new schedule is read in the zone the operator keeps now.
    const moved = savedBy(
      yield* setRoutine(
        session,
        turnId,
        { action: "update", id: created.id, schedule: "0 9 * * 1-5" },
        "call-3",
      ),
    );
    assert.deepStrictEqual(moved.trigger, {
      _tag: "schedule",
      cron: "0 9 * * 1-5",
      timeZone: "Europe/Lisbon",
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("reads a schedule in the zone the operator's device gave, before they chose one", () =>
  Effect.gen(function* () {
    yield* (yield* SettingsService).deviceTimeZone(TimeZone.make("America/Sao_Paulo"));
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Every day at 8:47, tell me what is on my calendar.");
    const turnId = yield* nextTurn(bot.id);

    const created = savedBy(
      yield* setRoutine(
        session,
        turnId,
        {
          action: "create",
          name: "Calendar",
          instruction: "Tell my user what is on their calendar today.",
          schedule: "47 8 * * *",
        },
        "call-1",
      ),
    );

    assert.deepStrictEqual(created.trigger, {
      _tag: "schedule",
      cron: "47 8 * * *",
      timeZone: "America/Sao_Paulo",
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a routine of another bot, and changes nothing", () =>
  Effect.gen(function* () {
    const { session, turnId } = yield* working;
    const other = yield* createBot("Bia");
    const theirs = yield* (yield* Routines).create({
      commandId: command(),
      botId: other.id,
      draft: {
        name: "Builds",
        instruction: "Check the nightly build.",
        trigger: { _tag: "webhook" },
      },
      author: { _tag: "operator" },
    });

    const reply = yield* setRoutine(session, turnId, { action: "pause", id: theirs.id }, "call-1");
    assert.strictEqual(reply._tag, "refused");
    const [after] = yield* (yield* Routines).list(other.id);
    assert.isTrue(after?.enabled);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The test clock starts at the epoch, 09:00 in Tokyo, and the scheduler takes what came due. */
const runDue = (iso: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe(iso).epochMilliseconds);
    yield* (yield* Scheduler).pass;
  });

/** The bot's routine as the operator sees it now. */
const routineNow = (botId: BotId, id: RoutineId) =>
  Effect.gen(function* () {
    const found = (yield* (yield* Routines).list(botId)).find((routine) => routine.id === id);
    if (found === undefined) return yield* Effect.die("The routine is gone");
    return found;
  });

it.effect("starts a one-time routine that ran again when the bot gives it a new time", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* working;
    const created = savedBy(
      yield* setRoutine(
        session,
        turnId,
        {
          action: "create",
          name: "Dentist",
          instruction: "Tell my user the dentist appointment is at 10:00 today.",
          at: "1970-01-01T09:10",
        },
        "call-1",
      ),
    );
    yield* runDue("1970-01-01T00:10:05Z");
    assert.isFalse((yield* routineNow(bot.id, created.id)).enabled);

    const again = savedBy(
      yield* setRoutine(
        session,
        turnId,
        { action: "update", id: created.id, at: "1970-01-01T09:40" },
        "call-2",
      ),
    );
    assert.isTrue(again.enabled);
    assert.deepStrictEqual(again.nextRunAt, DateTime.makeUnsafe("1970-01-01T00:40:00Z"));
    yield* runDue("1970-01-01T00:40:05Z");
    const { runs } = yield* (yield* Routines).runs({
      routineId: created.id,
      before: null,
      limit: 10,
    });
    // It came due at its new time; the first run is still going, so this one is skipped.
    assert.deepStrictEqual(
      runs.map((run) => [run.status, DateTime.formatIso(run.startedAt)]),
      [
        ["skipped", "1970-01-01T00:40:00.000Z"],
        ["running", "1970-01-01T00:10:00.000Z"],
      ],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a schedule that could never run, also for a paused routine", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* working;
    const created = savedBy(
      yield* setRoutine(
        session,
        turnId,
        {
          action: "create",
          name: "Builds",
          instruction: "Tell my user when the nightly build failed.",
          schedule: "0 7 * * *",
        },
        "call-1",
      ),
    );
    yield* setRoutine(session, turnId, { action: "pause", id: created.id }, "call-2");

    const crowded = yield* setRoutine(
      session,
      turnId,
      { action: "update", id: created.id, schedule: "* * * * *" },
      "call-3",
    );
    assert.deepStrictEqual(crowded, {
      _tag: "refused",
      message:
        'The schedule "* * * * *" cannot be used: it needs five cron fields that name a date that exists, and at most one run every five minutes.',
    });
    const after = yield* routineNow(bot.id, created.id);
    assert.deepStrictEqual([after.enabled, after.trigger], [false, created.trigger]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("rolls a refused call back whole, so a retry under its id acts once", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* working;
    const created = savedBy(
      yield* setRoutine(
        session,
        turnId,
        {
          action: "create",
          name: "Dentist",
          instruction: "Tell my user the dentist appointment is at 10:00 today.",
          at: "1970-01-01T09:10",
        },
        "call-1",
      ),
    );
    yield* runDue("1970-01-01T00:10:05Z");
    const resume = { action: "resume", id: created.id };
    const forward = (yield* BotTools).call({
      requestId: "call-2",
      sessionId: session,
      tool: "set_routine",
      arguments: resume,
    });

    // Its one-time run has passed: the resume is refused after the call was
    // pinned, in the transaction that would have applied it.
    assert.deepStrictEqual(yield* setRoutine(session, turnId, resume, "call-2"), {
      _tag: "refused",
      message:
        "This routine's one-time run has passed. Give it a new time, schedule or webhook with update; that starts it again.",
    });

    // The operator gives it a new time and keeps it paused; the retry resumes it.
    yield* (yield* Routines).update({
      commandId: command(),
      routineId: created.id,
      changes: {
        trigger: { _tag: "once", at: DateTime.makeUnsafe("1970-01-01T01:00:00Z") },
        enabled: false,
      },
      author: { _tag: "operator" },
    });
    const resumed = yield* forward;
    assert.isTrue(savedBy(resumed).enabled);
    assert.deepStrictEqual(yield* forward, resumed);

    const changes = (yield* conversation(bot.id)).flatMap((entry) =>
      entry._tag === "routine-change" ? [[entry.author._tag, entry.change]] : [],
    );
    assert.deepStrictEqual(changes, [
      ["bot", "created"],
      ["operator", "updated"],
      ["bot", "resumed"],
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it("refuses an event trigger missing what its event requires, or giving what it leaves out", () => {
  const schema = {
    type: "object",
    properties: { from: { type: "string" }, constructor: { type: "string" } },
    required: ["from", "constructor"],
    additionalProperties: false,
  };
  assert.strictEqual(
    eventArgumentsProblem(schema, { from: "ana@example.com" }),
    "It requires constructor in arguments.",
  );
  assert.strictEqual(
    eventArgumentsProblem(schema, { from: "a", constructor: "b", label: "c" }),
    "It takes no label; its arguments are from, constructor.",
  );
  assert.isUndefined(eventArgumentsProblem(schema, { from: "a", constructor: "b" }));
  // A schema that leaves its properties open takes any argument.
  assert.isUndefined(eventArgumentsProblem({ type: "object" }, { label: "c" }));
});
