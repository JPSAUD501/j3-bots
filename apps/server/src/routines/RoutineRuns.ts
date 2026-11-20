// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  NotFound,
  RateLimited,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { conversation, TurnsInvariant, WakeStatus } from "../turns/model.ts";
import { Wakes } from "../turns/Wakes.ts";

/** How many settled runs each routine keeps, newest first, beside the one still going. */
export const RUN_HISTORY = 100;

/**
 * How many runs, skipped ones included, a routine's webhook may record in a
 * minute. A caller past it is told when to try again, and nothing is recorded.
 */
export const WEBHOOK_RUNS_PER_MINUTE = 10;

const RoutineRow = Schema.Struct({
  id: RoutineId,
  bot_id: BotId,
  trigger_json: json(RoutineTrigger),
  enabled: Flag,
  webhook_secret: Schema.NullOr(Schema.String),
});

const RunStatus = RoutineRun.fields.status;

const Ended = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  bot_id: BotId,
  wake_status: Schema.NullOr(WakeStatus),
  wake_updated_at: Schema.NullOr(Time),
  spoke: Flag,
});

/** A run as a webhook caller is told of it. */
export interface RunReceipt {
  readonly runId: RoutineRunId;
  readonly status: typeof RunStatus.Type;
  /** The request repeated the `Idempotency-Key` of an earlier one, which recorded this run. */
  readonly replayed: boolean;
}

/**
 * Why a webhook request was not taken: no routine with that address
 * (`unknown`, also for a wrong secret, so a caller learns nothing about which
 * routines exist), or a paused routine.
 */
export class WebhookRefused extends Schema.TaggedError<WebhookRefused>()("WebhookRefused", {
  reason: Schema.Literals(["unknown", "paused"]),
}) {}

const encoder = new TextEncoder();

/**
 * A routine's runs (`docs/architecture/server.md`, Routines): each one is
 * recorded with the wake that runs it, in one transaction, so a run exists
 * exactly when its wake does. A run that comes due while the routine's
 * previous run is still going is recorded as skipped, with no wake.
 *
 * A run's wake waits for a side session of its own: the dispatcher never
 * plans a routine's wake into the bot's main session. The side-session
 * runner (M2, part 2) opens that session, dispatches the wake into it, and
 * tags what the run says with its wake. A run settles from its wake: when
 * the wake finished, as `delivered` if the bot said something in the run and
 * `silent` otherwise; when it failed, was cancelled (a Stop of the bot), or
 * is gone, as `failed`.
 */
export class RoutineRuns extends Context.Service<
  RoutineRuns,
  {
    /**
     * Records the run of a routine that came due, in the caller's
     * transaction, which also moves the routine on to its next run.
     */
    readonly due: (routine: {
      readonly id: RoutineId;
      readonly botId: BotId;
    }) => Effect.Effect<RunReceipt>;
    /** Runs the routine now at the operator's request, as a test: also a paused one. */
    readonly runNow: (routineId: RoutineId) => Effect.Effect<RunReceipt, NotFound>;
    /**
     * A call of a routine's webhook. `secret` is compared in constant time;
     * `body` reaches the bot as data. A `requestKey` already recorded for the
     * routine records nothing and answers the run it recorded.
     */
    readonly webhook: (input: {
      readonly routineId: string;
      readonly secret: string;
      readonly body: string;
      readonly requestKey: string | null;
    }) => Effect.Effect<RunReceipt, WebhookRefused | RateLimited>;
    /** Settles every run whose wake ended, in the caller's transaction. */
    readonly settle: Effect.Effect<void>;
  }
>()("@j3-bots/server/routines/RoutineRuns") {}

export const layer = Layer.effect(
  RoutineRuns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const ids = yield* Ids;
    const wakes = yield* Wakes;
    const changes = yield* ChangeLog;
    const digest = yield* Digest.Digest;

    const routineRow = SqlSchema.findOneOption({
      Request: RoutineId,
      Result: RoutineRow,
      execute: (id) => sql`
        SELECT id, bot_id, trigger_json, enabled, webhook_secret FROM routines WHERE id = ${id}
      `,
    });

    const endedRows = SqlSchema.findAll({
      Request: Schema.NullOr(RoutineId),
      Result: Ended,
      execute: (routineId) => sql`
        SELECT r.id, r.routine_id, ro.bot_id, w.status AS wake_status,
          w.updated_at AS wake_updated_at,
          EXISTS (
            SELECT 1 FROM entries e
            WHERE e.wake_id = r.wake_id AND e.author_kind = 'bot' AND e.kind = 'message'
          ) AS spoke
        FROM routine_runs r
        JOIN routines ro ON ro.id = r.routine_id
        LEFT JOIN wakes w ON w.id = r.wake_id
        WHERE r.status = 'running'
          AND (w.id IS NULL OR w.status IN ('finished', 'cancelled', 'failed'))
          ${routineId === null ? sql`` : sql`AND r.routine_id = ${routineId}`}
        ORDER BY r.started_at, r.id
      `,
    });

    const recordChange = (botId: BotId, routineId: RoutineId) =>
      changes.record({ _tag: "routines", botId }, routineId);

    /** Settles the runs whose wake ended: every routine's, or one routine's. */
    const settleEnded = Effect.fn("RoutineRuns.settleEnded")(function* (
      routineId: RoutineId | null,
    ) {
      const now = yield* DateTime.now;
      for (const run of yield* endedRows(routineId)) {
        const status =
          run.wake_status === "finished" ? (run.spoke ? "delivered" : "silent") : "failed";
        yield* sql`
          UPDATE routine_runs SET status = ${status},
            finished_at = ${timeText(run.wake_updated_at ?? now)}
          WHERE id = ${run.id} AND status = 'running'
        `;
        yield* recordChange(run.bot_id, run.routine_id);
      }
    }, Effect.orDie);

    /** Drops the routine's oldest settled runs past `RUN_HISTORY`; the run going stays. */
    const prune = (routineId: RoutineId) => sql`
      DELETE FROM routine_runs
      WHERE routine_id = ${routineId} AND status <> 'running'
        AND id NOT IN (
          SELECT id FROM routine_runs WHERE routine_id = ${routineId} AND status <> 'running'
          ORDER BY started_at DESC, id DESC LIMIT ${RUN_HISTORY}
        )
    `;

    /**
     * Records a run of the routine, in the caller's transaction: skipped
     * while its previous run is still going, otherwise running with its wake.
     */
    const begin = Effect.fn("RoutineRuns.begin")(function* (
      routine: { readonly id: RoutineId; readonly botId: BotId },
      request: { readonly body: string | null; readonly key: string | null },
    ) {
      yield* settleEnded(routine.id);
      const at = timeText(yield* DateTime.now);
      const runId = RoutineRunId.make(yield* ids.make("run"));
      const going = yield* sql`
        SELECT 1 FROM routine_runs WHERE routine_id = ${routine.id} AND status = 'running'
      `;
      if (going.length > 0) {
        yield* sql`
          INSERT INTO routine_runs (id, routine_id, status, request_key, started_at, finished_at)
          VALUES (${runId}, ${routine.id}, 'skipped', ${request.key}, ${at}, ${at})
        `;
      } else {
        const [wakeId] = yield* wakes.record([
          {
            botId: routine.botId,
            kind: "routine",
            audience: conversation,
            payload: { _tag: "routine", routineId: routine.id, runId },
            sourceEntryId: null,
            hops: 0,
            retryOf: null,
            cause: { _tag: "routine" },
          },
        ]);
        if (wakeId === undefined) {
          return yield* Effect.die(
            new TurnsInvariant({ invariant: "A routine's wake is always written" }),
          );
        }
        yield* sql`
          INSERT INTO routine_runs (
            id, routine_id, wake_id, status, trigger_data, request_key, started_at
          ) VALUES (
            ${runId}, ${routine.id}, ${wakeId}, 'running', ${request.body}, ${request.key}, ${at}
          )
        `;
        yield* sql`UPDATE routines SET run_count = run_count + 1 WHERE id = ${routine.id}`;
      }
      yield* prune(routine.id);
      yield* recordChange(routine.botId, routine.id);
      return {
        runId,
        status: going.length > 0 ? "skipped" : "running",
        replayed: false,
      } satisfies RunReceipt;
    }, Effect.orDie);

    const due = (routine: { readonly id: RoutineId; readonly botId: BotId }) =>
      begin(routine, { body: null, key: null });

    const runNow = Effect.fn("RoutineRuns.runNow")(function* (routineId: RoutineId) {
      return yield* transaction(
        Effect.gen(function* () {
          const row = yield* routineRow(routineId).pipe(Effect.orDie);
          if (Option.isNone(row)) return yield* new NotFound({ resource: "routine" });
          return yield* begin(
            { id: row.value.id, botId: row.value.bot_id },
            { body: null, key: null },
          );
        }),
      );
    });

    /** Whether `presented` is `secret`, in time that does not depend on where they differ. */
    const sameSecret = Effect.fn("RoutineRuns.sameSecret")(function* (
      presented: string,
      secret: string,
    ) {
      // Equal-length digests, so not even the length of the secret shows.
      const a = yield* digest.digest(Digest.sha256, encoder.encode(presented));
      const b = yield* digest.digest(Digest.sha256, encoder.encode(secret));
      return Mac.timingSafeEqual(a, b);
    });

    const webhook = Effect.fn("RoutineRuns.webhook")(function* (input: {
      readonly routineId: string;
      readonly secret: string;
      readonly body: string;
      readonly requestKey: string | null;
    }) {
      const unknown = new WebhookRefused({ reason: "unknown" });
      const id = Schema.decodeOption(RoutineId)(input.routineId);
      if (Option.isNone(id)) return yield* unknown;
      return yield* transaction(
        Effect.gen(function* () {
          const row = yield* routineRow(id.value).pipe(Effect.orDie);
          // The secret is compared even when there is no routine to compare it with.
          const secret = Option.match(row, {
            onNone: () => null,
            onSome: (found) =>
              found.trigger_json._tag === "webhook" ? found.webhook_secret : null,
          });
          const matches = yield* sameSecret(input.secret, secret ?? "");
          if (Option.isNone(row) || secret === null || !matches) return yield* unknown;
          const routine = row.value;
          if (input.requestKey !== null) {
            const [earlier] = yield* SqlSchema.findAll({
              Request: Schema.String,
              Result: Schema.Struct({ id: RoutineRunId, status: RunStatus }),
              execute: (key) => sql`
                SELECT id, status FROM routine_runs
                WHERE routine_id = ${routine.id} AND request_key = ${key}
              `,
            })(input.requestKey).pipe(Effect.orDie);
            if (earlier !== undefined) {
              return {
                runId: earlier.id,
                status: earlier.status,
                replayed: true,
              } satisfies RunReceipt;
            }
          }
          if (!routine.enabled) return yield* new WebhookRefused({ reason: "paused" });
          const now = yield* DateTime.now;
          const windowStart = DateTime.subtractDuration(now, Duration.minutes(1));
          const recent = yield* SqlSchema.findAll({
            Request: Schema.String,
            Result: Schema.Struct({ started_at: Time }),
            execute: (since) => sql`
              SELECT started_at FROM routine_runs
              WHERE routine_id = ${routine.id} AND started_at > ${since}
              ORDER BY started_at
            `,
          })(timeText(windowStart)).pipe(Effect.orDie);
          const oldest = recent[0];
          if (recent.length >= WEBHOOK_RUNS_PER_MINUTE && oldest !== undefined) {
            return yield* new RateLimited({
              retryAt: DateTime.addDuration(oldest.started_at, Duration.minutes(1)),
            });
          }
          return yield* begin(
            { id: routine.id, botId: routine.bot_id },
            { body: input.body, key: input.requestKey },
          );
        }),
      );
    });

    return RoutineRuns.of({ due, runNow, webhook, settle: settleEnded(null) });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
