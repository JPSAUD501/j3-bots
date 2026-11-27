// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Author,
  BotId,
  type CommandError,
  type CommandId,
  Conflict,
  hasSeveralSteps,
  NonNegativeInt,
  NotFound,
  Routine,
  type RoutineAnswer,
  type RoutineRun,
  RoutineId,
  RoutineMissed,
  RoutineRunId,
  RoutineStep,
  routineStepsProblem,
  RoutineTrigger,
  type Sequence,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { Listener } from "../listener.ts";
import { ChangeLog, scopeKey } from "../persistence/ChangeLog.ts";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { ServerConfig } from "../config.ts";
import { CERTIFICATE_NAME, Network, reachableOrigins } from "../system/Network.ts";
import { Ledger } from "../turns/Ledger.ts";
import { conversation, DispatchRowId } from "../turns/model.ts";
import { Signals } from "../turns/Signals.ts";
import { Stops } from "../turns/Stops.ts";
import { RoutineRuns } from "./RoutineRuns.ts";
import { runCards, runStops, type StepTurn } from "./runSteps.ts";
import { RUN_COLUMNS, RunRow, runView } from "./runView.ts";
import { plannedRun } from "./schedule.ts";
import { Scheduler } from "./Scheduler.ts";
import { WEBHOOK_PATH } from "./webhook.ts";

/** The bytes of a webhook's secret: 256 bits, drawn once per webhook trigger. */
const SECRET_BYTES = 32;

/**
 * A new webhook secret, which goes in the address after the routine's id:
 * drawn as a routine gets a webhook, and by an import, which brings none.
 */
export const newWebhookSecret = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return Base64Url.encode(yield* random.randomBytes(SECRET_BYTES));
});

const RoutineRow = Schema.Struct({
  id: RoutineId,
  bot_id: BotId,
  name: Schema.String,
  instruction: Schema.String,
  trigger_json: json(RoutineTrigger),
  enabled: Flag,
  webhook_secret: Schema.NullOr(Schema.String),
  next_run_at: Schema.NullOr(Time),
  run_count: NonNegativeInt,
  missed_json: Schema.NullOr(Schema.String),
  steps_json: Schema.NullOr(json(Schema.Array(RoutineStep))),
});

const decodeRoutine = Schema.decodeUnknownEffect(Routine);
const decodeMissed = Schema.decodeOption(json(RoutineMissed));
const encodeTrigger = Schema.encodeEffect(json(RoutineTrigger));
const encodeSteps = Schema.encodeEffect(json(Schema.Array(RoutineStep)));

/**
 * What a routine saves of its steps (decision 0080): its first bot step's
 * brief as its instruction, and its steps, or null for a one-step routine,
 * which its instruction is all of. Steps that make no routine are the
 * caller's mistake: the bot's tool checks them first.
 */
const shapeOf = Effect.fn("Routines.shapeOf")(function* (
  owner: BotId,
  steps: ReadonlyArray<RoutineStep>,
) {
  const problem = routineStepsProblem(steps);
  const [first] = steps;
  if (problem !== undefined || first?._tag !== "bot") {
    return yield* Effect.die(`Steps that make no routine reached Routines: ${problem ?? ""}`);
  }
  return {
    instruction: first.instruction,
    stepsJson: hasSeveralSteps(steps, owner) ? yield* encodeSteps(steps) : null,
  };
});

/** `steps` with the first bot step's brief replaced. */
const withFirstBrief = (
  steps: ReadonlyArray<RoutineStep>,
  instruction: string,
): ReadonlyArray<RoutineStep> =>
  steps.map((step, index) =>
    index === 0 && step._tag === "bot" ? { ...step, instruction } : step,
  );

/** Whether two triggers are the same: the same schedule, time or webhook. */
const sameTrigger = (a: RoutineTrigger, b: RoutineTrigger): boolean => {
  switch (a._tag) {
    case "schedule":
      return b._tag === "schedule" && a.cron === b.cron && a.timeZone === b.timeZone;
    case "once":
      return b._tag === "once" && DateTime.Equivalence(a.at, b.at);
    case "webhook":
      return b._tag === "webhook";
  }
};

export type RoutineFrame =
  | {
      readonly _tag: "snapshot";
      readonly sequence: Sequence;
      readonly routines: ReadonlyArray<Routine>;
    }
  | {
      readonly _tag: "changed";
      readonly sequence: Sequence;
      readonly upsert: ReadonlyArray<Routine>;
      readonly remove: ReadonlyArray<RoutineId>;
    };

/** What a routine is created with. */
export interface RoutineDraft {
  readonly name: string;
  /** Its brief; with `steps`, ignored for the first bot step's. */
  readonly instruction: string;
  /** Its steps, for a routine a bot builds in steps (decision 0080). */
  readonly steps?: ReadonlyArray<RoutineStep>;
  readonly trigger: RoutineTrigger;
  /** False creates it paused, as a template's routines are. On when left out. */
  readonly enabled?: boolean;
}

/** The changes `routine.update` may ask for. */
export interface RoutineChanges {
  readonly name?: string;
  /** For a routine with several steps, its first bot step's brief. */
  readonly instruction?: string;
  /** All its steps, replaced. */
  readonly steps?: ReadonlyArray<RoutineStep>;
  readonly trigger?: RoutineTrigger;
  readonly enabled?: boolean;
}

/**
 * Routines, as the operator manages them. Running them is the scheduler's
 * (`Scheduler.ts`): it reads `next_run_at` and records runs. Each change made
 * here is recorded in the routines' change history and shown in the bot's
 * conversation as a routine-change entry.
 */
export class Routines extends Context.Service<
  Routines,
  {
    readonly list: (botId: BotId) => Effect.Effect<ReadonlyArray<Routine>>;
    readonly runs: (input: {
      readonly routineId: RoutineId;
      readonly before: RoutineRunId | null;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly runs: ReadonlyArray<RoutineRun>; readonly hasOlder: boolean },
      NotFound
    >;
    /**
     * `commandId` makes the command act once under a retried id; `null` is for
     * a caller whose own record does that, a bot's pinned `set_routine` call,
     * so the routine as saved is kept nowhere else.
     */
    readonly create: (input: {
      readonly commandId: CommandId | null;
      readonly botId: BotId;
      readonly draft: RoutineDraft;
      readonly author: Author;
    }) => Effect.Effect<Routine, CommandError>;
    readonly update: (input: {
      readonly commandId: CommandId | null;
      readonly routineId: RoutineId;
      readonly changes: RoutineChanges;
      readonly author: Author;
    }) => Effect.Effect<Routine, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId | null;
      readonly routineId: RoutineId;
      readonly author: Author;
    }) => Effect.Effect<void, CommandError>;
    /** Runs the routine now, as a test, also a paused one. Skipped if a run is still going. */
    readonly run: (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
    }) => Effect.Effect<void, CommandError>;
    /** `routine.answer`: the operator's answer to the yes a run waits for. */
    readonly answer: (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
      readonly choice: RoutineAnswer["choice"];
      readonly note: string | null;
    }) => Effect.Effect<void, CommandError>;
    /** `routine.retry`: Try again of a run that failed at a step. */
    readonly retry: (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
    }) => Effect.Effect<void, CommandError>;
    /** `routine.stopRun`: Stop of a run of a routine with several steps. */
    readonly stopRun: (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
    }) => Effect.Effect<void, CommandError>;
    /** Resumes with `after` as `Entries.subscribe` does. */
    readonly subscribe: (
      botId: BotId,
      after: Sequence | null,
    ) => Stream.Stream<RoutineFrame, NotFound>;
  }
>()("@j3-bots/server/routines/Routines") {}

export const layer = Layer.effect(
  Routines,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const changes = yield* ChangeLog;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const ids = yield* Ids;
    const random = yield* SecureRandom.SecureRandom;
    const ledger = yield* Ledger;
    const signals = yield* Signals;
    const routineRuns = yield* RoutineRuns;
    const stops = yield* Stops;
    const view = runView(sql);
    const runStopper = runStops(sql, ledger, changes, runCards(sql, entries, changes));
    const scheduler = yield* Scheduler;
    const network = yield* Network;
    const listener = yield* Listener;
    const { publicOrigin } = yield* ServerConfig;

    /** A command applied once under its id, or, with none, in a transaction of its caller's. */
    const receipted = <A, I, E, R>(input: {
      readonly commandId: CommandId | null;
      readonly method: string;
      readonly payload: unknown;
      readonly result: Schema.Codec<A, I>;
      readonly apply: Effect.Effect<A, E, R>;
    }) =>
      input.commandId === null
        ? transaction(input.apply)
        : receipts.once({ ...input, commandId: input.commandId });

    const newSecret = newWebhookSecret.pipe(
      Effect.provideService(SecureRandom.SecureRandom, random),
    );

    /**
     * Where another device calls a webhook: the first address `j3-bots pair`
     * offers, the public origin when one is set, else one for the listener as
     * bound, read when asked since interfaces come and go. With none, as
     * `pair` says it: over HTTPS, a placeholder for a name on the
     * certificate; over HTTP on every interface, loopback. The listener is
     * read, not awaited: a routine is often read in a transaction, and only
     * clients, which come through the bound listener, are given one.
     */
    const origin = Effect.gen(function* () {
      const polled = yield* Deferred.poll(listener);
      if (Option.isNone(polled)) {
        return yield* Effect.die("A webhook's address was asked for before the listener bound");
      }
      const bound = yield* polled.value;
      const [reached] = yield* reachableOrigins(bound, publicOrigin).pipe(
        Effect.provideService(Network, network),
      );
      if (reached !== undefined) return reached;
      const shown = bound.scheme === "https" ? CERTIFICATE_NAME : "127.0.0.1";
      return `${bound.scheme}://${shown}:${bound.port}`;
    });

    /**
     * `routine` with its webhook's address on the listener as bound now. A
     * command's receipt keeps the address given when it ran, whose port the
     * system may have chosen differently since; the path stays.
     */
    const readdressed = Effect.fn("Routines.readdressed")(function* (routine: Routine) {
      if (routine.webhookUrl === null) return routine;
      const path = routine.webhookUrl.indexOf(`${WEBHOOK_PATH}/${routine.id}/`);
      if (path === -1) return yield* Effect.die("A webhook's address holds its path");
      return { ...routine, webhookUrl: `${yield* origin}${routine.webhookUrl.slice(path)}` };
    });

    const SELECT = sql.literal(`
      SELECT id, bot_id, name, instruction, trigger_json, enabled, webhook_secret, next_run_at,
        run_count, missed_json, steps_json
      FROM routines
    `);
    const RUNS = sql.literal(`SELECT ${RUN_COLUMNS} FROM routine_runs`);

    const routineRows = SqlSchema.findAll({
      Request: Schema.Struct({
        botId: Schema.NullOr(BotId),
        ids: Schema.NullOr(Schema.Array(RoutineId)),
      }),
      Result: RoutineRow,
      execute: ({ botId, ids: routineIds }) =>
        routineIds !== null
          ? sql`${SELECT} WHERE ${sql.in("id", routineIds)} ORDER BY created_at, id`
          : sql`${SELECT} WHERE bot_id = ${botId} ORDER BY created_at, id`,
    });
    const runRows = SqlSchema.findAll({
      Request: Schema.Struct({
        routineId: RoutineId,
        before: Schema.NullOr(RoutineRunId),
        limit: Schema.Number,
      }),
      Result: RunRow,
      execute: ({ routineId, before, limit }) => sql`
        ${RUNS}
        WHERE routine_id = ${routineId}
          ${
            before === null
              ? sql``
              : sql`AND (started_at, id) < (
                  SELECT started_at, id FROM routine_runs WHERE id = ${before}
                )`
          }
        ORDER BY started_at DESC, id DESC
        LIMIT ${limit}
      `,
    });

    const pendingWakes = SqlSchema.findAll({
      Request: RoutineId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (routineId) => sql`
        SELECT id FROM wakes WHERE routine_id = ${routineId} AND status = 'pending'
      `,
    });

    /**
     * The routine's dispatches written and never sent: a provider's usage
     * limit, or a full budget, may hold one. A send claimed now is not one:
     * it may already be in the engine.
     */
    const unsentDispatches = SqlSchema.findAll({
      Request: RoutineId,
      Result: Schema.Struct({ id: DispatchRowId }),
      execute: (routineId) => sql`
        SELECT d.id FROM wakes w JOIN dispatches d ON d.id = w.dispatch_id
        WHERE w.routine_id = ${routineId} AND w.status = 'dispatched'
          AND d.status = 'intended' AND d.attempts = 0
      `,
    });

    const toRun = view.toRun;

    const toRoutine = Effect.fn("Routines.toRoutine")(function* (row: typeof RoutineRow.Type) {
      const [last] = yield* runRows({ routineId: row.id, before: null, limit: 1 });
      return yield* decodeRoutine({
        id: row.id,
        botId: row.bot_id,
        name: row.name,
        instruction: row.instruction,
        ...(row.steps_json === null ? {} : { steps: row.steps_json }),
        trigger: row.trigger_json,
        enabled: row.enabled,
        webhookUrl:
          row.webhook_secret === null
            ? null
            : `${yield* origin}${WEBHOOK_PATH}/${row.id}/${row.webhook_secret}`,
        nextRunAt: row.next_run_at,
        lastRun: last === undefined ? null : yield* toRun(last),
        runCount: row.run_count,
        // Missed runs another version of the server wrote in a form this one
        // cannot read are left out.
        missed: row.missed_json === null ? null : Option.getOrNull(decodeMissed(row.missed_json)),
      });
    }, Effect.orDie);

    const select = Effect.fn("Routines.select")(function* (filter: {
      readonly botId: BotId | null;
      readonly ids: ReadonlyArray<RoutineId> | null;
    }) {
      const rows = yield* routineRows(filter).pipe(Effect.orDie);
      return yield* Effect.forEach(rows, toRoutine);
    });

    const find = Effect.fn("Routines.find")(function* (routineId: RoutineId) {
      const [routine] = yield* select({ botId: null, ids: [routineId] });
      if (routine === undefined) return yield* new NotFound({ resource: "routine" });
      return routine;
    });

    const requireBot = Effect.fn("Routines.requireBot")(function* (botId: BotId) {
      const rows = yield* sql`SELECT 1 FROM bots WHERE id = ${botId}`.pipe(Effect.orDie);
      if (rows.length === 0) return yield* new NotFound({ resource: "bot" });
    });

    /** Records the change and shows it in the bot's conversation. */
    const announce = Effect.fn("Routines.announce")(function* (
      routine: Routine,
      change: "created" | "updated" | "paused" | "resumed" | "deleted",
      author: Author,
    ) {
      yield* changes.record(
        { _tag: "routines", botId: routine.botId },
        routine.id,
        change === "deleted",
      );
      yield* entries.append({
        target: { _tag: "conversation", botId: routine.botId },
        entry: {
          _tag: "routine-change",
          author,
          routineId: routine.id,
          name: routine.name,
          change,
          trigger: routine.trigger,
          ...(routine.steps === undefined || change === "deleted" ? {} : { steps: routine.steps }),
        },
      });
    });

    /** Ends what a Stop of a run leaves running: its step's turn, in that bot's side session. */
    const endTurns = Effect.fn("Routines.endTurns")(function* (turns: ReadonlyArray<StepTurn>) {
      for (const turn of turns) {
        yield* stops.endTurn(turn.botId, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          audience: conversation,
        });
      }
    });

    const create = Effect.fn("Routines.create")(function* (input: {
      readonly commandId: CommandId | null;
      readonly botId: BotId;
      readonly draft: RoutineDraft;
      readonly author: Author;
    }) {
      return yield* receipted({
        commandId: input.commandId,
        method: "routine.create",
        payload: { botId: input.botId, draft: input.draft },
        result: Routine,
        apply: Effect.gen(function* () {
          yield* requireBot(input.botId);
          const now = yield* DateTime.now;
          // Planned also for a paused routine: a trigger the server refuses is refused either way.
          const planned = yield* plannedRun(input.draft.trigger, now);
          const enabled = input.draft.enabled ?? true;
          const next = enabled ? planned : Option.none();
          const id = RoutineId.make(yield* ids.make("routine"));
          const secret = input.draft.trigger._tag === "webhook" ? yield* newSecret : null;
          const at = timeText(now);
          const shape =
            input.draft.steps === undefined
              ? { instruction: input.draft.instruction, stepsJson: null }
              : yield* shapeOf(input.botId, input.draft.steps);
          yield* sql`
            INSERT INTO routines (
              id, bot_id, name, instruction, trigger_json, enabled, webhook_secret, next_run_at,
              created_at, updated_at, steps_json
            ) VALUES (
              ${id}, ${input.botId}, ${input.draft.name}, ${shape.instruction},
              ${yield* encodeTrigger(input.draft.trigger)}, ${enabled ? 1 : 0}, ${secret},
              ${Option.match(next, { onNone: () => null, onSome: timeText })}, ${at}, ${at},
              ${shape.stepsJson}
            )
          `;
          const routine = yield* find(id);
          yield* announce(routine, "created", input.author);
          yield* scheduler.nudge;
          return routine;
        }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die)),
      });
    }, Effect.flatMap(readdressed));

    const update = Effect.fn("Routines.update")(function* (input: {
      readonly commandId: CommandId | null;
      readonly routineId: RoutineId;
      readonly changes: RoutineChanges;
      readonly author: Author;
    }) {
      const { changes: change } = input;
      return yield* receipted({
        commandId: input.commandId,
        method: "routine.update",
        payload: { routineId: input.routineId, changes: change },
        result: Routine,
        apply: Effect.gen(function* () {
          const [row] = yield* routineRows({ botId: null, ids: [input.routineId] });
          if (row === undefined) return yield* new NotFound({ resource: "routine" });
          const before = yield* toRoutine(row);
          // A change that sends the saved trigger again, as a form sending the
          // whole draft does, gives no new one.
          const retriggered =
            change.trigger !== undefined && !sameTrigger(change.trigger, before.trigger);
          const trigger = change.trigger ?? before.trigger;
          const now = yield* DateTime.now;
          // A one-time routine whose time has passed, whether it ran or was
          // paused before its time, starts again when given a new trigger,
          // unless the same change pauses it.
          const passed =
            before.trigger._tag === "once" && !DateTime.isGreaterThan(before.trigger.at, now);
          const enabled = change.enabled ?? (before.enabled || (passed && retriggered));
          // A new trigger is checked also on a paused routine, so a resume
          // never meets one that could not have been saved.
          const planned = retriggered ? yield* plannedRun(trigger, now) : Option.none();
          // The next run moves only with a new trigger or the switch: an edit
          // of the name or the instruction leaves a run that is due to happen.
          const next = !enabled
            ? Option.none()
            : retriggered
              ? planned
              : enabled !== before.enabled
                ? yield* plannedRun(trigger, now)
                : Option.fromNullishOr(row.next_run_at);
          // A webhook keeps its address while it stays a webhook.
          const secret =
            trigger._tag === "webhook" ? (row.webhook_secret ?? (yield* newSecret)) : null;
          // Steps replace all of them; an instruction alone is the first bot step's brief.
          const steps =
            change.steps ??
            (before.steps !== undefined && change.instruction !== undefined
              ? withFirstBrief(before.steps, change.instruction)
              : before.steps);
          const shape =
            steps === undefined
              ? { instruction: change.instruction ?? before.instruction, stepsJson: null }
              : yield* shapeOf(before.botId, steps);
          yield* sql`
            UPDATE routines SET ${sql.update({
              name: change.name ?? before.name,
              instruction: shape.instruction,
              steps_json: shape.stepsJson,
              trigger_json: yield* encodeTrigger(trigger),
              enabled: enabled ? 1 : 0,
              webhook_secret: secret,
              next_run_at: Option.match(next, { onNone: () => null, onSome: timeText }),
              // The runs it missed were the old trigger's.
              ...(retriggered ? { missed_json: null } : {}),
              updated_at: timeText(now),
            })}
            WHERE id = ${before.id}
          `;
          const routine = yield* find(before.id);
          const kind =
            change.enabled !== undefined && change.enabled !== before.enabled
              ? change.enabled
                ? "resumed"
                : "paused"
              : "updated";
          yield* announce(routine, kind, input.author);
          yield* scheduler.nudge;
          return routine;
        }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die)),
      });
    }, Effect.flatMap(readdressed));

    const remove = Effect.fn("Routines.remove")(function* (input: {
      readonly commandId: CommandId | null;
      readonly routineId: RoutineId;
      readonly author: Author;
    }) {
      yield* receipted({
        commandId: input.commandId,
        method: "routine.delete",
        payload: { routineId: input.routineId },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const routine = yield* find(input.routineId);
          // A run of its steps that is going ends as a Stop ends it, first.
          const going = yield* sql<{ readonly id: string }>`
            SELECT id FROM routine_runs
            WHERE routine_id = ${routine.id} AND status = 'running' AND steps_json IS NOT NULL
          `.pipe(Effect.orDie);
          for (const { id } of going) {
            const stopped = yield* runStopper.stopRun(RoutineRunId.make(id));
            if (Option.isSome(stopped)) yield* endTurns(stopped.value);
          }
          // A run still waiting for its session, or for its first send, has
          // nothing left to run. Its side session is retired then.
          for (const unsent of yield* unsentDispatches(routine.id).pipe(Effect.orDie)) {
            yield* ledger.release(unsent.id, { _tag: "cancelled" });
          }
          const waiting = yield* pendingWakes(routine.id).pipe(Effect.orDie);
          yield* ledger.cancelWakes(waiting.map((wake) => wake.id));
          yield* sql.afterCommit(signals.routines.fire);
          yield* sql`DELETE FROM routines WHERE id = ${routine.id}`.pipe(Effect.orDie);
          yield* announce(routine, "deleted", input.author);
        }),
      });
    });

    const run = Effect.fn("Routines.run")(function* (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "routine.run",
        payload: { routineId: input.routineId },
        result: Schema.Void,
        apply: Effect.asVoid(routineRuns.runNow(input.routineId)),
      });
    });

    const answer = Effect.fn("Routines.answer")(function* (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
      readonly choice: RoutineAnswer["choice"];
      readonly note: string | null;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "routine.answer",
        payload: { runId: input.runId, choice: input.choice, note: input.note },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const outcome = yield* routineRuns.answer(input);
          if (outcome === "closed") return yield* new Conflict({ reason: "card-closed" });
        }),
      });
    });

    const retry = Effect.fn("Routines.retry")(function* (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "routine.retry",
        payload: { runId: input.runId },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          if (!(yield* routineRuns.retry(input.runId))) {
            return yield* new Conflict({ reason: "not-retryable" });
          }
        }),
      });
    });

    const stopRun = Effect.fn("Routines.stopRun")(function* (input: {
      readonly commandId: CommandId;
      readonly runId: RoutineRunId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "routine.stopRun",
        payload: { runId: input.runId },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const stopped = yield* runStopper.stopRun(input.runId);
          if (Option.isNone(stopped)) return yield* new Conflict({ reason: "card-closed" });
          yield* endTurns(stopped.value);
          yield* sql.afterCommit(signals.routines.fire);
        }),
      });
    });

    const list = Effect.fn("Routines.list")(function* (botId: BotId) {
      return yield* select({ botId, ids: null });
    });

    const runs = Effect.fn("Routines.runs")(function* (input: {
      readonly routineId: RoutineId;
      readonly before: RoutineRunId | null;
      readonly limit: number;
    }) {
      yield* find(input.routineId);
      const rows = yield* runRows({ ...input, limit: input.limit + 1 }).pipe(Effect.orDie);
      return {
        runs: yield* Effect.forEach(rows.slice(0, input.limit), toRun),
        hasOlder: rows.length > input.limit,
      };
    });

    const snapshot = Effect.fn("Routines.snapshot")(function* (botId: BotId) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* requireBot(botId);
          const sequence = yield* changes.watermark;
          return {
            _tag: "snapshot",
            sequence,
            routines: yield* list(botId),
          } satisfies RoutineFrame;
        }),
      );
    });

    const changesSince = Effect.fn("Routines.changesSince")(function* (
      botId: BotId,
      after: Sequence,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* requireBot(botId);
          const resume = yield* changes.since({ _tag: "routines", botId }, after);
          if (resume._tag === "gap") return Option.none<RoutineFrame>();
          const last = resume.changes.at(-1);
          const touched = [
            ...new Set(resume.changes.map((change) => RoutineId.make(change.entityId))),
          ];
          const upsert = touched.length === 0 ? [] : yield* select({ botId: null, ids: touched });
          const present = new Set(upsert.map((routine) => routine.id));
          return Option.some<RoutineFrame>({
            _tag: "changed",
            sequence: last?.sequence ?? after,
            upsert,
            remove: touched.filter((id) => !present.has(id)),
          });
        }),
      );
    });

    const subscribe = (botId: BotId, after: Sequence | null) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const signals = yield* changes.subscribe;
          const key = scopeKey({ _tag: "routines", botId });
          const resumed = after === null ? Option.none() : yield* changesSince(botId, after);
          const first = Option.isSome(resumed) ? resumed.value : yield* snapshot(botId);
          let sequence = first.sequence;
          return Stream.concat(
            Stream.succeed(first),
            Stream.fromSubscription(signals).pipe(
              Stream.filter((scope) => scopeKey(scope) === key),
              Stream.mapEffect(() =>
                changesSince(botId, sequence).pipe(
                  // Too much changed at once to replay: start over.
                  Effect.flatMap(
                    Option.match({ onNone: () => snapshot(botId), onSome: Effect.succeed }),
                  ),
                ),
              ),
              Stream.filter(
                (frame) =>
                  frame._tag === "snapshot" || frame.upsert.length > 0 || frame.remove.length > 0,
              ),
              Stream.tap((frame) =>
                Effect.sync(() => {
                  sequence = frame.sequence;
                }),
              ),
            ),
          );
        }),
      );

    return Routines.of({
      list,
      runs,
      create,
      update,
      remove,
      run,
      answer,
      retry,
      stopRun,
      subscribe,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
