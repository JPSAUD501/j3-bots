// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type Bot,
  type BotId,
  type CommandError,
  CommandId,
  type Notification,
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RoutineRunId,
  type RoutineStep,
} from "@j3-bots/contracts";
import { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Devices } from "../devices/Devices.ts";
import * as Domain from "../domain.ts";
import { Presence } from "../presence/Presence.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  conversation,
  createBot,
  eventually,
  stopSettled,
  timesSent,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Stops } from "../turns/Stops.ts";
import { Routines } from "./Routines.ts";

const GATHER = "Gather last week's emails into a list.";
const DRAFT = "Draft a reply to each email on the list.";

const gather = (botId: BotId): RoutineStep => ({
  _tag: "bot",
  botId,
  action: "gathers last week's emails",
  instruction: GATHER,
});

const draft = (botId: BotId): RoutineStep => ({
  _tag: "bot",
  botId,
  action: "drafts the replies",
  instruction: DRAFT,
});

const yes: RoutineStep = { _tag: "yes", onlyIf: null, waitHours: 24 };

const ASK = { question: "Send the 3 replies?", yes: "Send", no: "Hold" };

/** A webhook routine of `owner` with these steps, run once on demand. */
const ranRoutine = (owner: Bot, steps: ReadonlyArray<RoutineStep>) =>
  Effect.gen(function* () {
    const routines = yield* Routines;
    const routine = yield* routines.create({
      commandId: command(),
      botId: owner.id,
      draft: { name: "Inbox", instruction: GATHER, trigger: { _tag: "webhook" }, steps },
      author: { _tag: "operator" },
    });
    yield* routines.run({ commandId: command(), routineId: routine.id });
    return routine;
  });

/** The routine's newest run. */
const latest = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const { runs } = yield* (yield* Routines).runs({ routineId, before: null, limit: 1 });
    return Option.fromNullishOr(runs[0]);
  });

/** Waits for the routine's newest run to be as `holds` asks, and returns it. */
const runWhen = (routine: Routine, holds: (run: RoutineRun) => boolean) =>
  eventually(latest(routine.id).pipe(Effect.map(Option.filter(holds))));

const settled = (routine: Routine) => runWhen(routine, (run) => run.status !== "running");

const states = (run: RoutineRun) => (run.steps ?? []).map((step) => step.state);

const StepTurnRow = Schema.Struct({ engine_session_id: SessionId, admitted_turn_id: TurnId });

/**
 * Waits for the turn of `botId`'s step of the routine's run that is going,
 * in a side session of that bot other than `previous`.
 */
const stepTurn = (routineId: RoutineId, botId: BotId, previous: SessionId | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.Struct({ routineId: Schema.String, botId: Schema.String }),
      Result: StepTurnRow,
      execute: (request) => sql`
        SELECT s.engine_session_id, s.admitted_turn_id FROM sessions s
        JOIN routine_runs r ON r.wake_id = s.side_wake_id
        WHERE r.routine_id = ${request.routineId} AND r.status = 'running'
          AND s.bot_id = ${request.botId} AND s.purpose = 'side' AND s.retired_at IS NULL AND s.lost_at IS NULL
          AND s.engine_session_id IS NOT NULL AND s.admitted_turn_id IS NOT NULL
      `,
    });
    return yield* eventually(
      find({ routineId, botId }).pipe(
        Effect.orDie,
        Effect.map(Option.filter((row) => row.engine_session_id !== previous)),
      ),
    );
  });

type StepTurn = typeof StepTurnRow.Type;

let calls = 0;

/** The step's bot calls `tool` from its turn. */
const callTool = (turn: StepTurn, tool: "finish_step" | "say", input: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: turn.engine_session_id,
      turnId: turn.admitted_turn_id,
      tool,
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `step-call-${++calls}`,
      sessionId: turn.engine_session_id,
      tool,
      arguments: input,
    });
  });

const finishStep = (turn: StepTurn, input: Schema.Json) => callTool(turn, "finish_step", input);

const endTurn = (turn: StepTurn) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: turn.engine_session_id,
      turnId: turn.admitted_turn_id,
      outcome: { _tag: "completed" },
    });
  });

/** The bot does its step: it reports `input`, and its turn ends. */
const doStep = (turn: StepTurn, input: Schema.Json) =>
  Effect.gen(function* () {
    assert.strictEqual((yield* finishStep(turn, input))._tag, "result");
    yield* endTurn(turn);
  });

/** How many wakes the routine gave `botId`. */
const wakesOf = (routineId: RoutineId, botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM wakes WHERE routine_id = ${routineId} AND bot_id = ${botId}
    `.pipe(Effect.orDie);
    return row?.n ?? 0;
  });

/** Why the command was refused as a conflict. */
const conflictOf = <A, R>(effect: Effect.Effect<A, CommandError, R>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.strictEqual(error._tag, "Conflict");
    return error._tag === "Conflict" ? error.reason : null;
  });

const answer = (runId: RoutineRunId, choice: "yes" | "no", note: string | null = null) =>
  Effect.gen(function* () {
    yield* (yield* Routines).answer({ commandId: command(), runId, choice, note });
  });

it.effect(
  "runs each step as its own bot's turn, hands the next step what the one before reported, and delivers what they said",
  () =>
    Effect.gen(function* () {
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const routine = yield* ranRoutine(ana, [gather(ana.id), draft(bia.id)]);

      const first = yield* stepTurn(routine.id, ana.id);
      assert.strictEqual(yield* timesSent(first.engine_session_id, GATHER), 1);
      yield* callTool(first, "say", { text: "Fourteen new emails this week." });
      assert.strictEqual(
        (yield* finishStep(first, { result: "14 new emails", handoff: "Ids 41 to 54" }))._tag,
        "result",
      );
      // One report per attempt.
      assert.strictEqual((yield* finishStep(first, { result: "15 new emails" }))._tag, "refused");
      yield* endTurn(first);

      const second = yield* stepTurn(routine.id, bia.id);
      assert.strictEqual(yield* timesSent(second.engine_session_id, DRAFT), 1);
      assert.strictEqual(yield* timesSent(second.engine_session_id, "14 new emails"), 1);
      assert.strictEqual(yield* timesSent(second.engine_session_id, "Ids 41 to 54"), 1);
      yield* doStep(second, { result: "14 drafts" });

      const run = yield* settled(routine);
      assert.strictEqual(run.status, "delivered");
      assert.deepStrictEqual(states(run), ["done", "done"]);
      assert.deepStrictEqual(
        (run.steps ?? []).map((step) => step.result),
        ["14 new emails", "14 drafts"],
      );
      assert.strictEqual(run.delivered.length, 1);
      // The run's card, in the owner's conversation, ends as the run did.
      const cards = (yield* conversation(ana.id)).flatMap((entry) =>
        entry._tag === "routine-run" ? [entry] : [],
      );
      assert.deepStrictEqual(
        cards.map((card) => card.run.status),
        ["delivered"],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "waits for the operator's yes, tells them of it, and gives the next step the yes with its note",
  () =>
    Effect.gen(function* () {
      yield* (yield* SettingsService).update({
        commandId: CommandId.make("previews"),
        changes: { notifications: { enabled: true, previews: true } },
      });
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const devices = yield* Devices;
      const { code } = yield* devices.startPairing;
      const viewer = yield* (yield* Presence).connect(
        (yield* devices.pair({ code, name: "Laptop" })).deviceId,
      );
      const heard = yield* Queue.unbounded<Notification>();
      yield* viewer.notifications.pipe(
        Stream.runForEach((notification) => Queue.offer(heard, notification)),
        Effect.forkScoped({ startImmediately: true }),
      );

      const routine = yield* ranRoutine(ana, [gather(ana.id), yes, draft(bia.id)]);
      const first = yield* stepTurn(routine.id, ana.id);
      // A yes follows: the report says what it asks.
      assert.strictEqual((yield* finishStep(first, { result: "3 need a reply" }))._tag, "refused");
      yield* doStep(first, { result: "3 need a reply", ask: ASK });

      const waiting = yield* runWhen(routine, (run) => states(run)[1] === "waiting");
      assert.strictEqual(waiting.steps?.[1]?.ask?.question, ASK.question);
      const notice = yield* Queue.take(heard);
      assert.deepStrictEqual(
        [notice.kind, notice.routine, notice.preview],
        ["question", { name: "Inbox", reason: "yes", stepBotId: null }, ASK.question],
      );
      assert.strictEqual(yield* wakesOf(routine.id, bia.id), 0);

      yield* answer(waiting.id, "yes", "Only the first two.");
      const second = yield* stepTurn(routine.id, bia.id);
      assert.strictEqual(yield* timesSent(second.engine_session_id, ASK.question), 1);
      assert.strictEqual(yield* timesSent(second.engine_session_id, "Only the first two."), 1);
      yield* doStep(second, { result: "2 sent" });

      const run = yield* settled(routine);
      // Nobody said a word to the operator.
      assert.strictEqual(run.status, "silent");
      assert.deepStrictEqual(states(run), ["done", "yes", "done"]);
      assert.strictEqual(yield* conflictOf(answer(run.id, "no")), "card-closed");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends the run quietly at a no, and at a yes nobody answered in time", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const bia = yield* createBot("Bia");
    const routine = yield* ranRoutine(ana, [
      gather(ana.id),
      { _tag: "yes", onlyIf: null, waitHours: 1 },
      draft(bia.id),
    ]);

    yield* doStep(yield* stepTurn(routine.id, ana.id), { result: "3 need a reply", ask: ASK });
    const asked = yield* runWhen(routine, (run) => states(run)[1] === "waiting");
    yield* answer(asked.id, "no");
    const refused = yield* settled(routine);
    assert.strictEqual(refused.status, "silent");
    assert.deepStrictEqual(states(refused), ["done", "no", "skipped"]);

    yield* TestClock.adjust("1 minute");
    yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
    const again = yield* stepTurn(routine.id, ana.id);
    yield* doStep(again, { result: "3 need a reply", ask: ASK });
    const open = yield* runWhen(routine, (run) => states(run)[1] === "waiting");
    yield* TestClock.adjust("61 minutes");
    const lapsed = yield* settled(routine);
    assert.strictEqual(lapsed.id, open.id);
    assert.strictEqual(lapsed.status, "silent");
    assert.deepStrictEqual(states(lapsed), ["done", "timed-out", "skipped"]);
    assert.strictEqual(yield* conflictOf(answer(open.id, "yes")), "card-closed");
    assert.strictEqual(yield* wakesOf(routine.id, bia.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops quietly at a condition that does not hold", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const bia = yield* createBot("Bia");
    const routine = yield* ranRoutine(ana, [
      gather(ana.id),
      { _tag: "condition", check: "there's something new" },
      draft(bia.id),
    ]);

    const first = yield* stepTurn(routine.id, ana.id);
    // A condition follows: the report says whether it holds.
    assert.strictEqual((yield* finishStep(first, { result: "Nothing new" }))._tag, "refused");
    yield* doStep(first, { result: "Nothing new", goOn: false });

    const run = yield* settled(routine);
    assert.strictEqual(run.status, "silent");
    assert.deepStrictEqual(states(run), ["done", "stopped", "skipped"]);
    assert.strictEqual(run.steps?.[1]?.result, "Nothing new");
    assert.strictEqual(yield* wakesOf(routine.id, bia.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "fails a step whose turn ended without a report, and Try again resumes the run from that step",
  () =>
    Effect.gen(function* () {
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const routine = yield* ranRoutine(ana, [gather(ana.id), draft(bia.id)]);
      yield* doStep(yield* stepTurn(routine.id, ana.id), { result: "14 new emails" });
      const second = yield* stepTurn(routine.id, bia.id);
      yield* endTurn(second);

      const failed = yield* settled(routine);
      assert.strictEqual(failed.status, "failed");
      assert.deepStrictEqual(states(failed), ["done", "failed"]);
      assert.deepStrictEqual(
        [failed.steps?.[1]?.failure, failed.steps?.[1]?.partial, failed.retryable],
        ["unreported", true, true],
      );

      yield* (yield* Routines).retry({ commandId: command(), runId: failed.id });
      const again = yield* stepTurn(routine.id, bia.id, second.engine_session_id);
      // What the first step reported is kept, and it does not run again.
      assert.strictEqual(yield* timesSent(again.engine_session_id, "14 new emails"), 1);
      yield* doStep(again, { result: "14 drafts" });

      const resumed = yield* settled(routine);
      assert.strictEqual(resumed.id, failed.id);
      assert.deepStrictEqual(states(resumed), ["done", "done"]);
      assert.strictEqual(yield* wakesOf(routine.id, ana.id), 1);
      assert.strictEqual(
        yield* conflictOf((yield* Routines).retry({ commandId: command(), runId: failed.id })),
        "not-retryable",
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "ends the step another bot is doing at a Stop of the routine's bot, and nothing else of that bot",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const routine = yield* ranRoutine(ana, [gather(ana.id), draft(bia.id)]);
      yield* doStep(yield* stepTurn(routine.id, ana.id), { result: "14 new emails" });
      yield* stepTurn(routine.id, bia.id);

      yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
      yield* stopSettled;

      const run = yield* settled(routine);
      assert.strictEqual(run.status, "failed");
      assert.deepStrictEqual(states(run), ["done", "failed"]);
      assert.deepStrictEqual([run.steps?.[1]?.failure, run.retryable], ["stopped", false]);
      // Bia's step's turn ended, and Bia's own conversation was not stopped.
      yield* until(
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM sessions s JOIN turns t ON t.session_id = s.id
          WHERE s.bot_id = ${bia.id} AND s.purpose = 'side' AND t.finished_at IS NULL
        `.pipe(
          Effect.orDie,
          Effect.map(([row]) => (row?.n ?? 0) === 0),
        ),
      );
      const stoppedMain = yield* sql`
        SELECT 1 FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        WHERE s.bot_id = ${bia.id} AND s.purpose = 'main'
      `.pipe(Effect.orDie);
      assert.strictEqual(stoppedMain.length, 0);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a run waiting for a yes at Stop on its card, which then takes no answer", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const bia = yield* createBot("Bia");
    const routine = yield* ranRoutine(ana, [gather(ana.id), yes, draft(bia.id)]);
    yield* doStep(yield* stepTurn(routine.id, ana.id), { result: "3 need a reply", ask: ASK });
    const waiting = yield* runWhen(routine, (run) => states(run)[1] === "waiting");

    yield* (yield* Routines).stopRun({ commandId: command(), runId: waiting.id });

    const run = yield* settled(routine);
    assert.strictEqual(run.status, "failed");
    assert.deepStrictEqual(states(run), ["done", "failed", "skipped"]);
    assert.strictEqual(run.steps?.[1]?.failure, "stopped");
    assert.strictEqual(yield* conflictOf(answer(run.id, "yes")), "card-closed");
    assert.strictEqual(
      yield* conflictOf((yield* Routines).stopRun({ commandId: command(), runId: run.id })),
      "card-closed",
    );
    assert.strictEqual(yield* wakesOf(routine.id, bia.id), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("goes on with a run after a restart of the server", () =>
  Effect.gen(function* () {
    // The first step reports, and the server stops before its turn ends.
    const { routine, bia, first } = yield* Effect.gen(function* () {
      const ana = yield* createBot("Ana");
      const bia = yield* createBot("Bia");
      const routine = yield* ranRoutine(ana, [gather(ana.id), draft(bia.id)]);
      const first = yield* stepTurn(routine.id, ana.id);
      assert.strictEqual(
        (yield* finishStep(first, { result: "14 new emails", handoff: "Ids 41 to 54" }))._tag,
        "result",
      );
      return { routine, bia, first };
    }).pipe(Effect.provide(Domain.layer));

    yield* Effect.gen(function* () {
      yield* endTurn(first);
      const second = yield* stepTurn(routine.id, bia.id);
      assert.strictEqual(yield* timesSent(second.engine_session_id, "Ids 41 to 54"), 1);
      yield* doStep(second, { result: "14 drafts" });
      const run = yield* settled(routine);
      assert.strictEqual(run.status, "silent");
      assert.deepStrictEqual(states(run), ["done", "done"]);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);
