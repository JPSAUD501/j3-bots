// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Author,
  BotId,
  type CommandError,
  type CommandId,
  EntryId,
  NonNegativeInt,
  NotFound,
  Routine,
  RoutineId,
  RoutineMissed,
  type RoutineRun,
  RoutineRunFailure,
  RoutineRunId,
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
import { DispatchRowId } from "../turns/model.ts";
import { Signals } from "../turns/Signals.ts";
import { isLate, RoutineRuns } from "./RoutineRuns.ts";
import { plannedRun } from "./schedule.ts";
import { Scheduler } from "./Scheduler.ts";
import { WEBHOOK_PATH } from "./webhook.ts";

/** The bytes of a webhook's secret: 256 bits, drawn once per webhook trigger. */
const SECRET_BYTES = 32;

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
});

const RunRow = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  wake_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "delivered", "silent", "failed", "skipped"]),
  attempts: NonNegativeInt,
  note: Schema.NullOr(Schema.String),
  started_at: Time,
  finished_at: Schema.NullOr(Time),
  failure_json: Schema.NullOr(json(RoutineRunFailure)),
  due_at: Schema.NullOr(Time),
});

const decodeRoutine = Schema.decodeUnknownEffect(Routine);
const decodeMissed = Schema.decodeOption(json(RoutineMissed));
const encodeTrigger = Schema.encodeEffect(json(RoutineTrigger));

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
  readonly instruction: string;
  readonly trigger: RoutineTrigger;
}

/** The changes `routine.update` may ask for. */
export interface RoutineChanges {
  readonly name?: string;
  readonly instruction?: string;
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

    /** A new webhook secret, which goes in the address after the routine's id. */
    const newSecret = Effect.map(random.randomBytes(SECRET_BYTES), Base64Url.encode);

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
        run_count, missed_json
      FROM routines
    `);
    const RUNS = sql.literal(`
      SELECT id, routine_id, wake_id, status, attempts, note, started_at, finished_at,
        failure_json, due_at
      FROM routine_runs
    `);

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

    const toRun = Effect.fn("Routines.toRun")(function* (row: typeof RunRow.Type) {
      const delivered =
        row.wake_id === null
          ? []
          : yield* sql<{ readonly id: string }>`
              SELECT id FROM entries
              WHERE wake_id = ${row.wake_id} AND author_kind = 'bot' AND kind = 'message'
              ORDER BY seq
            `;
      return {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        attempts: row.attempts,
        delivered: delivered.map((entry) => EntryId.make(entry.id)),
        note: row.note,
        ...(row.status === "failed" && row.failure_json !== null
          ? { failure: row.failure_json }
          : {}),
        ...(row.due_at !== null && isLate(row.due_at, row.started_at) ? { dueAt: row.due_at } : {}),
      } satisfies RoutineRun;
    }, Effect.orDie);

    const toRoutine = Effect.fn("Routines.toRoutine")(function* (row: typeof RoutineRow.Type) {
      const [last] = yield* runRows({ routineId: row.id, before: null, limit: 1 });
      return yield* decodeRoutine({
        id: row.id,
        botId: row.bot_id,
        name: row.name,
        instruction: row.instruction,
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
        missed:
          row.missed_json === null ? null : Option.getOrNull(decodeMissed(row.missed_json)),
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
        },
      });
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
          const next = yield* plannedRun(input.draft.trigger, now);
          const id = RoutineId.make(yield* ids.make("routine"));
          const secret = input.draft.trigger._tag === "webhook" ? yield* newSecret : null;
          const at = timeText(now);
          yield* sql`
            INSERT INTO routines (
              id, bot_id, name, instruction, trigger_json, webhook_secret, next_run_at,
              created_at, updated_at
            ) VALUES (
              ${id}, ${input.botId}, ${input.draft.name}, ${input.draft.instruction},
              ${yield* encodeTrigger(input.draft.trigger)}, ${secret},
              ${Option.match(next, { onNone: () => null, onSome: timeText })}, ${at}, ${at}
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
          yield* sql`
            UPDATE routines SET ${sql.update({
              name: change.name ?? before.name,
              instruction: change.instruction ?? before.instruction,
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

    return Routines.of({ list, runs, create, update, remove, run, subscribe });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
