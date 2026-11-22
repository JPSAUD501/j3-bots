// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A comparison whose time does not depend on where two values differ comes only from node:crypto.
import * as NodeCrypto from "node:crypto";
import {
  BotId,
  NotFound,
  RateLimited,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import { TurnOutcome } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import {
  conversation,
  DispatchSeq,
  DispatchStatus,
  TurnsInvariant,
  WakeFailure,
  WakeStatus,
} from "../turns/model.ts";
import { stopTargets } from "../turns/stopTargets.ts";
import { Wakes } from "../turns/Wakes.ts";

/** How many settled runs each routine keeps, newest first, beside the one still going. */
export const RUN_HISTORY = 100;

/**
 * How many times a run is tried at most. An attempt that fails before the bot
 * says anything (the engine could not open its session or lost it, its turn
 * failed, also before it started, or was interrupted by something other than
 * the operator) is tried again. One whose envelope the engine refused is not:
 * the next would be too.
 */
export const RUN_ATTEMPTS = 3;

/**
 * How long a run waits after its `n`th attempt failed before the next one
 * starts: 2 minutes, then 4. Long enough for a provider's passing error or an
 * engine restart to clear; a provider at its usage limit holds the attempt
 * until the reset anyway.
 */
export const retryDelay = (n: number): Duration.Duration => Duration.minutes(2 ** n);

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

/** What settling a run needs of its row, also when the rest of it cannot be read. */
const Identified = Schema.Struct({
  id: RoutineRunId,
  routine_id: RoutineId,
  bot_id: BotId,
});

const Ended = Schema.Struct({
  ...Identified.fields,
  wake_id: Schema.NullOr(Schema.String),
  attempts: Schema.Int,
  wake_status: Schema.NullOr(WakeStatus),
  wake_failure: Schema.NullOr(WakeFailure),
  wake_updated_at: Schema.NullOr(Time),
  dispatch_seq: Schema.NullOr(DispatchSeq),
  dispatch_status: Schema.NullOr(DispatchStatus),
  outcome_json: Schema.NullOr(json(TurnOutcome)),
  spoke: Flag,
});
type Ended = typeof Ended.Type;

/** What becomes of a run whose attempt's wake ended. */
type Settlement =
  | { readonly _tag: "settled"; readonly status: "delivered" | "silent" | "failed" }
  /** The attempt failed before the bot said anything: tried again, while attempts are left. */
  | { readonly _tag: "attempt-failed" }
  /** Its turn is still going: a `say` with `done` finished its wake early. */
  | { readonly _tag: "going" };

/** A dispatch the engine may still be working on. */
const OPEN_DISPATCH: ReadonlyArray<DispatchStatus> = ["intended", "accepted", "delivered"];

/** The engine took the dispatch, and its turn ended before it started. */
const endedBeforeStart = (run: Ended) =>
  run.dispatch_status === "dropped" && run.outcome_json !== null;

const settlementOf = (run: Ended): Settlement => {
  // What the bot said reached the operator: the run delivered, whatever came after.
  if (run.spoke) return { _tag: "settled", status: "delivered" };
  switch (run.wake_status) {
    case null:
    case "cancelled":
      // A Stop of the bot, or the routine's deletion, ended it.
      return { _tag: "settled", status: "failed" };
    case "failed":
      // The engine refused its envelope, or the runner found it too long to
      // send: the next attempt would fare no better. A turn the engine took
      // and ended before it started, a provider's passing failure say, keeps
      // its outcome on the dropped dispatch, and is tried again.
      return run.wake_failure === "rejected" && !endedBeforeStart(run)
        ? { _tag: "settled", status: "failed" }
        : { _tag: "attempt-failed" };
    case "finished":
      if (run.dispatch_status !== null && OPEN_DISPATCH.includes(run.dispatch_status)) {
        return { _tag: "going" };
      }
      return run.outcome_json?._tag === "completed"
        ? { _tag: "settled", status: "silent" }
        : { _tag: "attempt-failed" };
    case "pending":
    case "dispatched":
      return { _tag: "going" };
  }
};

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

/**
 * A routine's runs (`docs/architecture/server.md`, Routines): each one is
 * recorded with the wake that runs it, in one transaction, so a run exists
 * exactly when its wake does. A run that comes due while the routine's
 * previous run is still going is recorded as skipped, with no wake.
 *
 * A run's wake waits for a side session of its own: the dispatcher never
 * plans a routine's wake into the bot's main session. The routine runner
 * (`RoutineRunner.ts`) opens that session and dispatches the wake into it,
 * and what the run says is tagged with its wake (`turns/routineSpeech.ts`).
 * A run settles from its attempt's wake and that wake's dispatch: as
 * `delivered` once the bot said something; as `silent` when its turn
 * completed without a word; as `failed` when a Stop of the bot or the
 * routine's deletion ended it, or the engine refused its envelope. Another
 * attempt that failed before the bot said anything is tried again, after a
 * delay and up to `RUN_ATTEMPTS` attempts, with a new wake; the last one's
 * failure fails the run.
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
     * Whether a webhook call names a webhook, checked before anything else of
     * the call is read: `unknown` for a routine that does not exist, has
     * another trigger or another secret. The secrets' digests are compared in
     * time that does not depend on where they differ.
     */
    readonly admitWebhook: (input: {
      readonly routineId: string;
      readonly secret: string;
    }) => Effect.Effect<void, WebhookRefused>;
    /**
     * A call of a routine's webhook, once admitted. The address is checked
     * again, in the transaction that records the run, against a routine
     * deleted or given a new secret since. `body` reaches the bot as data. A
     * `requestKey` already recorded for the routine records nothing and
     * answers the run it recorded.
     */
    readonly webhook: (input: {
      readonly routineId: string;
      readonly secret: string;
      readonly body: string;
      readonly requestKey: string | null;
    }) => Effect.Effect<RunReceipt, WebhookRefused | RateLimited>;
    /**
     * Settles every run whose attempt ended, or records its next attempt, in
     * the caller's transaction.
     */
    readonly settle: Effect.Effect<void>;
  }
>()("@j3-bots/server/routines/RoutineRuns") {}

export const layer = Layer.effect(
  RoutineRuns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const stops = stopTargets(sql);
    const ids = yield* Ids;
    const wakes = yield* Wakes;
    const changes = yield* ChangeLog;

    const routineRow = SqlSchema.findOneOption({
      Request: RoutineId,
      Result: RoutineRow,
      execute: (id) => sql`
        SELECT id, bot_id, trigger_json, enabled, webhook_secret FROM routines WHERE id = ${id}
      `,
    });

    const endedRows = (routineId: RoutineId | null) => sql`
        SELECT r.id, r.routine_id, ro.bot_id, r.wake_id, r.attempts, w.status AS wake_status,
          w.failure_reason AS wake_failure, w.updated_at AS wake_updated_at, d.seq AS dispatch_seq, d.status AS dispatch_status,
          d.outcome_json,
          EXISTS (
            SELECT 1 FROM entries e
            WHERE e.wake_id = r.wake_id AND e.author_kind = 'bot' AND e.kind = 'message'
          ) AS spoke
        FROM routine_runs r
        JOIN routines ro ON ro.id = r.routine_id
        LEFT JOIN wakes w ON w.id = r.wake_id
        LEFT JOIN dispatches d ON d.id = w.dispatch_id
        WHERE r.status = 'running'
          AND (w.id IS NULL OR w.status IN ('finished', 'cancelled', 'failed'))
          ${routineId === null ? sql`` : sql`AND r.routine_id = ${routineId}`}
        ORDER BY r.started_at, r.id
      `;

    const runWithKey = SqlSchema.findOneOption({
      Request: Schema.Struct({ routineId: RoutineId, key: Schema.String }),
      Result: Schema.Struct({ id: RoutineRunId, status: RunStatus }),
      execute: ({ routineId, key }) => sql`
        SELECT id, status FROM routine_runs WHERE routine_id = ${routineId} AND request_key = ${key}
      `,
    });

    const runsSince = SqlSchema.findAll({
      Request: Schema.Struct({ routineId: RoutineId, since: Schema.String }),
      Result: Schema.Struct({ started_at: Time }),
      execute: ({ routineId, since }) => sql`
        SELECT started_at FROM routine_runs
        WHERE routine_id = ${routineId} AND started_at > ${since}
        ORDER BY started_at
      `,
    });

    const recordChange = (botId: BotId, routineId: RoutineId) =>
      changes.record({ _tag: "routines", botId }, routineId);

    /** Drops the routine's oldest settled runs past `RUN_HISTORY`; the run going stays. */
    const prune = (routineId: RoutineId) => sql`
      DELETE FROM routine_runs
      WHERE routine_id = ${routineId} AND status <> 'running'
        AND id NOT IN (
          SELECT id FROM routine_runs WHERE routine_id = ${routineId} AND status <> 'running'
          ORDER BY started_at DESC, id DESC LIMIT ${RUN_HISTORY}
        )
    `;

    /** Settles the run, which then joins the routine's kept history. */
    const finish = Effect.fn("RoutineRuns.finish")(function* (
      run: typeof Identified.Type,
      status: "delivered" | "silent" | "failed",
      at: DateTime.Utc,
    ) {
      yield* sql`
        UPDATE routine_runs SET status = ${status}, finished_at = ${timeText(at)}, retry_at = NULL
        WHERE id = ${run.id} AND status = 'running'
      `;
      // The cap on the kept history holds there too.
      yield* prune(run.routine_id);
      yield* recordChange(run.bot_id, run.routine_id);
    });

    /**
     * Settles the runs whose wake ended: every routine's, or one routine's. A
     * row that cannot be read whole, its dispatch's outcome written by
     * another version of the server say, fails its run, which is logged, so
     * the routine's later runs are not all skipped behind it.
     */
    const settleEnded = Effect.fn("RoutineRuns.settleEnded")(function* (
      routineId: RoutineId | null,
    ) {
      const now = yield* DateTime.now;
      for (const raw of yield* endedRows(routineId)) {
        const decoded = Schema.decodeUnknownOption(Ended)(raw);
        if (Option.isNone(decoded)) {
          const identified = Schema.decodeUnknownOption(Identified)(raw);
          if (Option.isNone(identified)) {
            yield* Effect.logError("A routine run could not be read to settle it");
            continue;
          }
          yield* Effect.logError("A routine run could not be read to settle it; it fails", {
            runId: identified.value.id,
          });
          yield* finish(identified.value, "failed", now);
          continue;
        }
        const run = decoded.value;
        let settlement = settlementOf(run);
        if (settlement._tag === "going") continue;
        if (settlement._tag === "attempt-failed") {
          // What the operator stopped is not tried again, also when its turn
          // ended on its own before the Stop's interrupt reached it.
          const stopped =
            run.dispatch_seq !== null &&
            (yield* stops.covers(run.bot_id, conversation, run.dispatch_seq));
          if (!stopped && run.attempts < RUN_ATTEMPTS && run.wake_id !== null) {
            yield* retry(run, now);
            continue;
          }
          settlement = { _tag: "settled", status: "failed" };
        }
        yield* finish(run, settlement.status, run.wake_updated_at ?? now);
      }
    }, Effect.orDie);

    /**
     * The run's next attempt: a new routine wake, which the runner gives a
     * fresh side session once the delay passes and the failed attempt's
     * session is out of use. The failed wake is the one it retries, so an
     * attempt is tried again once. The attempt is counted when it starts.
     */
    const retry = Effect.fn("RoutineRuns.retry")(function* (run: Ended, now: DateTime.Utc) {
      const [wakeId] = yield* wakes.record([
        {
          botId: run.bot_id,
          kind: "routine",
          audience: conversation,
          payload: { _tag: "routine", routineId: run.routine_id, runId: run.id },
          sourceEntryId: null,
          hops: 0,
          retryOf: run.wake_id,
          cause: { _tag: "routine" },
        },
      ]);
      if (wakeId === undefined) {
        return yield* Effect.die(
          new TurnsInvariant({ invariant: "A routine's wake is always written" }),
        );
      }
      // What the failed attempt failed of is no longer the run's last word.
      yield* sql`
        UPDATE routine_runs SET wake_id = ${wakeId}, failure_json = NULL,
          retry_at = ${timeText(DateTime.addDuration(now, retryDelay(run.attempts)))}
        WHERE id = ${run.id} AND status = 'running'
      `;
      yield* recordChange(run.bot_id, run.routine_id);
    });

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

    /**
     * Whether `presented` is `secret`. Their digests are compared in time that
     * does not depend on where they differ, and are of equal length, so not
     * even the secret's length shows.
     */
    const sameSecret = (presented: string, secret: string): boolean => {
      const digest = (text: string) =>
        NodeCrypto.createHash("sha256").update(text, "utf8").digest();
      return NodeCrypto.timingSafeEqual(digest(presented), digest(secret));
    };

    /**
     * The webhook routine `routineId` names, if `secret` is its secret. The
     * secret is compared even when there is no routine to compare it with.
     */
    const webhookRoutine = Effect.fn("RoutineRuns.webhookRoutine")(function* (input: {
      readonly routineId: string;
      readonly secret: string;
    }) {
      const id = Schema.decodeOption(RoutineId)(input.routineId);
      const row = Option.isSome(id)
        ? yield* routineRow(id.value).pipe(Effect.orDie)
        : Option.none<typeof RoutineRow.Type>();
      const secret = Option.match(row, {
        onNone: () => null,
        onSome: (found) => (found.trigger_json._tag === "webhook" ? found.webhook_secret : null),
      });
      const matches = sameSecret(input.secret, secret ?? "");
      return secret !== null && matches ? row : Option.none<typeof RoutineRow.Type>();
    });

    const admitWebhook = Effect.fn("RoutineRuns.admitWebhook")(function* (input: {
      readonly routineId: string;
      readonly secret: string;
    }) {
      if (Option.isNone(yield* webhookRoutine(input))) {
        return yield* new WebhookRefused({ reason: "unknown" });
      }
    });

    const webhook = Effect.fn("RoutineRuns.webhook")(function* (input: {
      readonly routineId: string;
      readonly secret: string;
      readonly body: string;
      readonly requestKey: string | null;
    }) {
      return yield* transaction(
        Effect.gen(function* () {
          const row = yield* webhookRoutine(input);
          if (Option.isNone(row)) return yield* new WebhookRefused({ reason: "unknown" });
          const routine = row.value;
          if (input.requestKey !== null) {
            const earlier = yield* runWithKey({
              routineId: routine.id,
              key: input.requestKey,
            }).pipe(Effect.orDie);
            if (Option.isSome(earlier)) {
              return {
                runId: earlier.value.id,
                status: earlier.value.status,
                replayed: true,
              } satisfies RunReceipt;
            }
          }
          if (!routine.enabled) return yield* new WebhookRefused({ reason: "paused" });
          const now = yield* DateTime.now;
          const windowStart = DateTime.subtractDuration(now, Duration.minutes(1));
          const recent = yield* runsSince({
            routineId: routine.id,
            since: timeText(windowStart),
          }).pipe(Effect.orDie);
          // `routine.run` can take the count past the limit, so a call is
          // taken again once the tenth newest run, not the oldest, leaves the window.
          const tenthNewest = recent[recent.length - WEBHOOK_RUNS_PER_MINUTE];
          if (tenthNewest !== undefined) {
            return yield* new RateLimited({
              retryAt: DateTime.addDuration(tenthNewest.started_at, Duration.minutes(1)),
            });
          }
          return yield* begin(
            { id: routine.id, botId: routine.bot_id },
            { body: input.body, key: input.requestKey },
          );
        }),
      );
    });

    return RoutineRuns.of({ due, runNow, admitWebhook, webhook, settle: settleEnded(null) });
  }),
);
