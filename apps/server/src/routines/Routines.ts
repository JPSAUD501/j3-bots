// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Author,
  BotId,
  type CommandError,
  type CommandId,
  EntryId,
  Invalid,
  NonNegativeInt,
  NotFound,
  Routine,
  RoutineId,
  type RoutineRun,
  RoutineRunId,
  RoutineTrigger,
  type Sequence,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ServerConfig } from "../config.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog, scopeKey } from "../persistence/ChangeLog.ts";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";

/** The least time between two runs of a schedule (`docs/architecture/server.md`, Routines). */
const MIN_SPACING = Duration.minutes(5);

/** How many upcoming runs of a schedule are checked against `MIN_SPACING`: over a week of them. */
const SPACING_CHECKS = 2_100;

/** Where a webhook trigger is called, with its secret after it. */
const WEBHOOK_PATH = "/hooks";

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
});

const RunRow = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  wake_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "delivered", "silent", "failed", "skipped"]),
  note: Schema.NullOr(Schema.String),
  started_at: Time,
  finished_at: Schema.NullOr(Time),
});

const decodeRoutine = Schema.decodeUnknownEffect(Routine);
const encodeTrigger = Schema.encodeEffect(json(RoutineTrigger));

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
 * The next time a trigger fires after `now`, or `None` when it never will
 * again. Fails with `Invalid` for a schedule that does not parse, names an
 * unknown time zone, or runs more often than every five minutes.
 */
const nextRun = (
  trigger: RoutineTrigger,
  now: DateTime.Utc,
): Effect.Effect<Option.Option<DateTime.Utc>, Invalid> => {
  switch (trigger._tag) {
    case "webhook":
      return Effect.succeedNone;
    case "once":
      return Effect.succeed(
        DateTime.isGreaterThan(trigger.at, now) ? Option.some(trigger.at) : Option.none(),
      );
    case "schedule": {
      if (Option.isNone(DateTime.zoneMakeNamed(trigger.timeZone))) {
        return Effect.fail(new Invalid({ reason: "time-zone" }));
      }
      const parsed = Cron.parse(trigger.cron, trigger.timeZone);
      if (Result.isFailure(parsed)) return Effect.fail(new Invalid({ reason: "schedule" }));
      let previous: DateTime.Utc | undefined;
      let first: DateTime.Utc | undefined;
      let checked = 0;
      for (const date of Cron.sequence(parsed.success, now)) {
        const at = DateTime.fromDateUnsafe(date);
        if (previous !== undefined) {
          if (Duration.isLessThan(DateTime.distance(previous, at), MIN_SPACING)) {
            return Effect.fail(new Invalid({ reason: "schedule" }));
          }
        }
        first ??= at;
        previous = at;
        if (++checked >= SPACING_CHECKS) break;
      }
      return Effect.succeed(Option.fromNullishOr(first));
    }
  }
};

/**
 * Routines, as the operator manages them. Running them is the scheduler's
 * (part of the wake pipeline): it reads `next_run_at` and records runs. Each
 * change made here is recorded in the routines' change history and shown in
 * the bot's conversation as a routine-change entry.
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
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly draft: RoutineDraft;
      readonly author: Author;
    }) => Effect.Effect<Routine, CommandError>;
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
      readonly changes: RoutineChanges;
      readonly author: Author;
    }) => Effect.Effect<Routine, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
      readonly author: Author;
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
    const config = yield* ServerConfig;
    const changes = yield* ChangeLog;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const ids = yield* Ids;

    const origin = `${config.tls._tag === "Some" ? "https" : "http"}://${
      config.host.includes(":") ? `[${config.host}]` : config.host
    }:${config.port}`;

    const SELECT = sql.literal(`
      SELECT id, bot_id, name, instruction, trigger_json, enabled, webhook_secret, next_run_at,
        run_count
      FROM routines
    `);
    const RUNS = sql.literal(`
      SELECT id, routine_id, wake_id, status, note, started_at, finished_at FROM routine_runs
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
        delivered: delivered.map((entry) => EntryId.make(entry.id)),
        note: row.note,
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
          row.webhook_secret === null ? null : `${origin}${WEBHOOK_PATH}/${row.webhook_secret}`,
        nextRunAt: row.next_run_at,
        lastRun: last === undefined ? null : yield* toRun(last),
        runCount: row.run_count,
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
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly draft: RoutineDraft;
      readonly author: Author;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        method: "routine.create",
        payload: { botId: input.botId, draft: input.draft },
        result: Routine,
        apply: Effect.gen(function* () {
          yield* requireBot(input.botId);
          const now = yield* DateTime.now;
          const next = yield* nextRun(input.draft.trigger, now);
          const id = RoutineId.make(yield* ids.make("routine"));
          const secret = input.draft.trigger._tag === "webhook" ? yield* ids.make("hook") : null;
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
          return routine;
        }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die)),
      });
    });

    const update = Effect.fn("Routines.update")(function* (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
      readonly changes: RoutineChanges;
      readonly author: Author;
    }) {
      const { changes: change } = input;
      return yield* receipts.once({
        commandId: input.commandId,
        method: "routine.update",
        payload: { routineId: input.routineId, changes: change },
        result: Routine,
        apply: Effect.gen(function* () {
          const [row] = yield* routineRows({ botId: null, ids: [input.routineId] });
          if (row === undefined) return yield* new NotFound({ resource: "routine" });
          const before = yield* toRoutine(row);
          const trigger = change.trigger ?? before.trigger;
          const enabled = change.enabled ?? before.enabled;
          const now = yield* DateTime.now;
          const next = enabled ? yield* nextRun(trigger, now) : Option.none();
          // A webhook keeps its address while it stays a webhook.
          const secret =
            trigger._tag === "webhook" ? (row.webhook_secret ?? (yield* ids.make("hook"))) : null;
          yield* sql`
            UPDATE routines SET ${sql.update({
              name: change.name ?? before.name,
              instruction: change.instruction ?? before.instruction,
              trigger_json: yield* encodeTrigger(trigger),
              enabled: enabled ? 1 : 0,
              webhook_secret: secret,
              next_run_at: Option.match(next, { onNone: () => null, onSome: timeText }),
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
          return routine;
        }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die)),
      });
    });

    const remove = Effect.fn("Routines.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly routineId: RoutineId;
      readonly author: Author;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "routine.delete",
        payload: { routineId: input.routineId },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const routine = yield* find(input.routineId);
          yield* sql`DELETE FROM routines WHERE id = ${routine.id}`.pipe(Effect.orDie);
          yield* announce(routine, "deleted", input.author);
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

    return Routines.of({ list, runs, create, update, remove, subscribe });
  }),
);
