// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  Label,
  RoutineId,
  RoutineInstruction,
  RoutineRunId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import { Engine, IdempotencyKey, SessionId } from "@j3-bots/engine-t3";
import {
  PROMPT_VERSION,
  renderWake,
  type RoutineRunSummary,
  type RoutineWake,
  type RoutineTrigger as EnvelopeTrigger,
} from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore, type StoredBot } from "../bots/BotStore.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { admission } from "../turns/admission.ts";
import { fitsEngine, operatorZone } from "../turns/envelopes.ts";
import { Ledger } from "../turns/Ledger.ts";
import { audienceColumns, conversation, DispatchRowId, SessionRowId } from "../turns/model.ts";
import { Observer } from "../turns/Observer.ts";
import { Readiness } from "../turns/Readiness.ts";
import {
  DEFECT_RETRY,
  type Pass,
  onePassAtATime,
  passOutcome,
  reconcile,
} from "../turns/reconciler.ts";
import { SessionGate } from "../turns/SessionGate.ts";
import { isIdle, sessionWork } from "../turns/sessionWork.ts";
import { Signals } from "../turns/Signals.ts";
import { RoutineRuns } from "./RoutineRuns.ts";

/** How many of a routine's earlier runs its envelope describes, newest first. */
const RECENT_RUNS = 5;

/** The most of what an earlier run said that its envelope repeats. */
const RECENT_RUN_TEXT = 2_000;

/** An attempt of a run whose wake waits for its side session. */
const Attempt = Schema.Struct({
  wake_id: Schema.String,
  bot_id: BotId,
  run_id: RoutineRunId,
  retry_at: Schema.NullOr(Time),
  trigger_data: Schema.NullOr(Schema.String),
  routine_id: RoutineId,
  name: Label,
  instruction: RoutineInstruction,
  trigger_json: json(RoutineTrigger),
});
type Attempt = typeof Attempt.Type;

const SideSession = Schema.Struct({
  id: SessionRowId,
  engine_session_id: Schema.NullOr(SessionId),
});

/** A live side session whose attempt has ended, or that the engine lost. */
const Spent = Schema.Struct({
  id: SessionRowId,
  engine_session_id: Schema.NullOr(SessionId),
  lost: Schema.BooleanFromBit,
});
type Spent = typeof Spent.Type;

const EarlierRun = Schema.Struct({
  wake_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["delivered", "silent", "failed", "skipped"]),
  note: Schema.NullOr(Schema.String),
  started_at: Time,
});

/** What one item of a pass came to. */
type Step = "done" | "deferred" | "unavailable";

const envelopeTrigger = (trigger: RoutineTrigger): EnvelopeTrigger => {
  switch (trigger._tag) {
    case "schedule":
      return { type: "schedule", cron: trigger.cron };
    case "once":
      return { type: "once" };
    case "webhook":
      return { type: "webhook" };
  }
};

const clipped = (text: string) =>
  text.length <= RECENT_RUN_TEXT ? text : `${text.slice(0, RECENT_RUN_TEXT)}…`;

/**
 * The routine runner (`docs/architecture/server.md`, Routines), a worker over
 * durable state like the turn machinery's. Each attempt of a routine run gets
 * a side session of its own, a fresh engine session in the bot's project with
 * the same instructions and memory, and the attempt's envelope is dispatched
 * there as a start; the dispatcher sends it under the turn budget, as it
 * sends every first send. The bot's main session is never woken for it.
 *
 * A pass settles the runs whose attempt ended (`RoutineRuns.settle`), which
 * may record a run's next attempt; opens a side session for every attempt
 * that is due, once the bot's provider is not at its usage limit; writes the
 * attempt's dispatch once the session's events are known and a turn slot is
 * free; and retires every side session whose attempt ended, once the engine
 * shows nothing left running there.
 */
export class RoutineRunner extends Context.Service<
  RoutineRunner,
  {
    /** One pass over the routine runs that are due or ended. */
    readonly pass: Effect.Effect<void>;
    /** The runner, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/routines/RoutineRunner") {}

export const layer = Layer.effect(
  RoutineRunner,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const ids = yield* Ids;
    const engine = yield* Engine;
    const engineState = yield* EngineState;
    const observer = yield* Observer;
    const bots = yield* BotStore;
    const entries = yield* Entries;
    const ledger = yield* Ledger;
    const runs = yield* RoutineRuns;
    const signals = yield* Signals;
    const readiness = yield* Readiness;
    const gate = yield* SessionGate;
    const settings = yield* SettingsStore;
    const random = yield* SecureRandom.SecureRandom;
    const { admitsStart } = admission(sql, settings);
    const workOf = sessionWork(sql);
    const zoneOf = operatorZone(settings);

    const attemptRows = sql`
      SELECT w.id AS wake_id, w.bot_id, r.id AS run_id, r.retry_at, r.trigger_data,
        ro.id AS routine_id, ro.name, ro.instruction, ro.trigger_json
      FROM wakes w
      JOIN routine_runs r ON r.wake_id = w.id
      JOIN routines ro ON ro.id = r.routine_id
      WHERE w.kind = 'routine' AND w.status = 'pending'
      ORDER BY w.rowid
    `.pipe(Effect.orDie);

    const sideSessionOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SideSession,
      execute: (wakeId) => sql`
        SELECT id, engine_session_id FROM sessions
        WHERE side_wake_id = ${wakeId} AND retired_at IS NULL AND lost_at IS NULL
      `,
    });

    const spentRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Spent,
      execute: () => sql`
        SELECT s.id, s.engine_session_id, s.lost_at IS NOT NULL AS lost FROM sessions s
        LEFT JOIN wakes w ON w.id = s.side_wake_id
        WHERE s.purpose = 'side' AND s.retired_at IS NULL
          AND (s.lost_at IS NOT NULL OR w.id IS NULL
            OR w.status IN ('finished', 'cancelled', 'failed'))
        ORDER BY s.rowid
      `,
    })(undefined).pipe(Effect.orDie);

    const earlierRuns = SqlSchema.findAll({
      Request: Schema.Struct({ routineId: RoutineId, runId: RoutineRunId }),
      Result: EarlierRun,
      execute: ({ routineId, runId }) => sql`
        SELECT wake_id, status, note, started_at FROM routine_runs
        WHERE routine_id = ${routineId} AND id <> ${runId} AND status <> 'running'
        ORDER BY started_at DESC, id DESC
        LIMIT ${RECENT_RUNS}
      `,
    });

    /** Whether the bot's provider is at its usage limit, which holds automated wakes. */
    const providerLimited = Effect.fn("RoutineRunner.providerLimited")(function* (bot: StoredBot) {
      const status = yield* engineState.current;
      const provider = status.providers.find((p) => p.id === bot.bot.model.providerId);
      return provider?.status._tag === "limited";
    });

    /** What an earlier run said, as one text; empty when its messages are gone. */
    const saidBy = Effect.fn("RoutineRunner.saidBy")(function* (wakeId: string) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM entries
        WHERE wake_id = ${wakeId} AND author_kind = 'bot' AND kind = 'message'
        ORDER BY seq
      `.pipe(Effect.orDie);
      const texts: Array<string> = [];
      for (const row of rows) {
        const found = yield* entries.find(EntryId.make(row.id));
        if (Option.isSome(found) && found.value.entry._tag === "message") {
          texts.push(found.value.entry.text);
        }
      }
      return texts.join("\n\n");
    });

    const recentRuns = Effect.fn("RoutineRunner.recentRuns")(function* (attempt: Attempt) {
      const rows = yield* earlierRuns({
        routineId: attempt.routine_id,
        runId: attempt.run_id,
      }).pipe(Effect.orDie);
      return yield* Effect.forEach(
        rows,
        Effect.fnUntraced(function* (run): Effect.fn.Return<RoutineRunSummary> {
          switch (run.status) {
            case "delivered":
              return {
                at: run.started_at,
                outcome: {
                  type: "delivered",
                  text: clipped(run.wake_id === null ? "" : yield* saidBy(run.wake_id)),
                },
              };
            case "silent":
              return {
                at: run.started_at,
                outcome: { type: "silent", note: run.note === null ? null : clipped(run.note) },
              };
            case "failed":
            case "skipped":
              return { at: run.started_at, outcome: { type: run.status } };
          }
        }),
      );
    });

    /**
     * The attempt's envelope: the routine, its trigger data, and as many of
     * its earlier runs as fit the engine's input limit, newest first.
     */
    const envelopeOf = Effect.fn("RoutineRunner.envelopeOf")(function* (attempt: Attempt) {
      const recent = yield* recentRuns(attempt);
      const base = {
        at: yield* DateTime.now,
        timeZone: yield* zoneOf,
        sinceLastTurn: [],
        kind: "routine",
        routine: {
          id: attempt.routine_id,
          name: attempt.name,
          trigger: envelopeTrigger(attempt.trigger_json),
          instruction: attempt.instruction,
        },
        triggerData: attempt.trigger_data,
      } as const;
      for (let count = recent.length; count > 0; count--) {
        const wake: RoutineWake = { ...base, recentRuns: recent.slice(0, count) };
        if (fitsEngine(wake)) return { wake, fits: true };
      }
      const alone: RoutineWake = { ...base, recentRuns: [] };
      return { wake: alone, fits: fitsEngine(alone) };
    });

    /** The attempt's side session, written now if it has none, while its wake still waits. */
    const sideSession = Effect.fn("RoutineRunner.sideSession")(function* (attempt: Attempt) {
      return yield* transaction(
        Effect.gen(function* () {
          const existing = yield* sideSessionOf(attempt.wake_id);
          if (Option.isSome(existing)) return existing;
          const pending = yield* sql`
            SELECT 1 FROM wakes WHERE id = ${attempt.wake_id} AND status = 'pending'
          `;
          if (pending.length === 0) return Option.none();
          const id = SessionRowId.make(yield* ids.make("session"));
          yield* sql`
            INSERT INTO sessions (id, bot_id, purpose, prompt_version, created_at, side_wake_id)
            VALUES (
              ${id}, ${attempt.bot_id}, 'side', ${PROMPT_VERSION}, ${timeText(yield* DateTime.now)},
              ${attempt.wake_id}
            )
          `;
          return Option.some({ id, engine_session_id: null });
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * Opens the side session in the engine, in the bot's project, with the
     * bot's model and permission mode. The row's id is the request's key, so
     * a retried opening returns the same engine session.
     */
    const openInEngine = Effect.fn("RoutineRunner.openInEngine")(function* (
      attempt: Attempt,
      found: StoredBot,
      sessionId: SessionRowId,
    ): Effect.fn.Return<Step> {
      if (Option.isNone(found.engineProjectId)) return "deferred";
      const opened = yield* engine
        .openSession({
          key: IdempotencyKey.make(sessionId),
          projectId: found.engineProjectId.value,
          title: `Routine: ${attempt.name}`,
          model: found.bot.model,
          permissionMode: found.bot.permissionMode,
        })
        .pipe(Effect.result);
      if (opened._tag === "Failure") {
        if (opened.failure._tag === "EngineUnavailable") return "unavailable";
        // Not now: the bot's project is being made again, its model is not
        // offered, or the engine's answer was lost. The same key is sent again.
        yield* Effect.logWarning("A routine's side session could not be opened yet", {
          routineId: attempt.routine_id,
          reason: opened.failure._tag,
        });
        return "deferred";
      }
      yield* sql`
        UPDATE sessions SET engine_session_id = ${opened.success}
        WHERE id = ${sessionId} AND engine_session_id IS NULL
      `.pipe(Effect.orDie);
      return "done";
    });

    /**
     * Writes the attempt's dispatch into its side session, in one transaction
     * that finds the wake still waiting and the session still live. The
     * dispatcher sends it. An envelope the engine would refuse fails as
     * refused, unsent, which fails the attempt.
     */
    const writeDispatch = Effect.fn("RoutineRunner.writeDispatch")(function* (
      attempt: Attempt,
      sessionId: SessionRowId,
    ): Effect.fn.Return<Step> {
      const { wake, fits } = yield* envelopeOf(attempt);
      const envelope = yield* renderWake(wake).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      yield* transaction(
        Effect.gen(function* () {
          const still = yield* sql`
            SELECT 1 FROM wakes w JOIN sessions s ON s.side_wake_id = w.id
            WHERE w.id = ${attempt.wake_id} AND w.status = 'pending' AND s.id = ${sessionId}
              AND s.retired_at IS NULL AND s.lost_at IS NULL
          `;
          if (still.length === 0) return;
          const id = DispatchRowId.make(yield* ids.make("dispatch"));
          const at = timeText(yield* DateTime.now);
          const { audience, roomId } = audienceColumns(conversation);
          yield* sql`
            INSERT INTO dispatches (
              id, bot_id, session_id, audience, audience_room_id, delivery, envelope, status,
              created_at, updated_at
            ) VALUES (
              ${id}, ${attempt.bot_id}, ${sessionId}, ${audience}, ${roomId}, 'start',
              ${envelope}, 'intended', ${at}, ${at}
            )
          `;
          yield* sql`
            UPDATE wakes SET status = 'dispatched', dispatch_id = ${id}, updated_at = ${at}
            WHERE id = ${attempt.wake_id}
          `;
          if (!fits) {
            yield* ledger.fail(id, "rejected", { _tag: "failed", reason: "rejected" });
            yield* sql.afterCommit(signals.routines.fire);
            return;
          }
          yield* sql.afterCommit(signals.dispatch.fire);
        }),
      ).pipe(Effect.orDie);
      return "done";
    });

    /** Takes one attempt as far as it can go now. */
    const advance = Effect.fn("RoutineRunner.advance")(function* (
      attempt: Attempt,
    ): Effect.fn.Return<Step> {
      const found = yield* bots.find(attempt.bot_id);
      if (Option.isNone(found)) return "done";
      // A provider at its usage limit holds automated wakes until its reset.
      if (yield* providerLimited(found.value)) return "deferred";
      const session = yield* sideSession(attempt);
      if (Option.isNone(session)) return "done";
      const { id } = session.value;
      if (session.value.engine_session_id === null) {
        const opened = yield* openInEngine(attempt, found.value, id);
        if (opened !== "done") return opened;
      }
      // Nothing is planned, and no slot taken, before the session's events are known.
      yield* observer.watch(id);
      if (!(yield* observer.ready(id))) return "deferred";
      // A routine waits for a free slot like any other start; the dispatcher
      // nudges nobody here when one frees, so the runner looks again shortly.
      if (!(yield* admitsStart(id))) return "deferred";
      return yield* writeDispatch(attempt, id);
    });

    /**
     * Takes a spent side session out of use, once nothing of it can still run:
     * no turn or dispatch the server knows of, no Stop unsettled, and the
     * engine's own account shows no turn it can still run and no background
     * work. A session never opened, or lost, is only recorded retired.
     */
    const retire = Effect.fn("RoutineRunner.retire")(function* (
      session: Spent,
    ): Effect.fn.Return<Step> {
      const record = transaction(
        sql`
          UPDATE sessions SET retired_at = ${timeText(yield* DateTime.now)}
          WHERE id = ${session.id} AND retired_at IS NULL
        `,
      ).pipe(Effect.orDie);
      if (session.lost || session.engine_session_id === null) {
        yield* record;
        return "done";
      }
      const engineSessionId = session.engine_session_id;
      // Still at work: the turn's end, or the Stop's confirmation, nudges the runner.
      const work = yield* workOf(session.id);
      if (!isIdle(work) || work.continuations > 0 || work.stopUnsettled) return "done";
      const synced = yield* observer.synchronize(session.id, engineSessionId).pipe(Effect.result);
      if (synced._tag === "Failure") {
        return synced.failure._tag === "EngineUnavailable" ? "unavailable" : "deferred";
      }
      // Background work the run left running, a dev server say, keeps its
      // session until it ends: retiring would stop it.
      if (synced.success.backgroundWork === "pending" || synced.success.runnableTurns.length > 0) {
        return "done";
      }
      return yield* gate.run(session.id)(
        Effect.gen(function* (): Effect.fn.Return<Step> {
          // Read again in the gate: nothing may have been sent meanwhile.
          const now = yield* workOf(session.id);
          if (!isIdle(now) || now.continuations > 0 || now.stopUnsettled) {
            return "deferred";
          }
          const retired = yield* engine.retireSession(engineSessionId).pipe(Effect.result);
          if (retired._tag === "Failure") {
            return retired.failure._tag === "EngineUnavailable" ? "unavailable" : "deferred";
          }
          yield* record;
          yield* observer.close(session.id);
          return "done";
        }),
      );
    });

    /** A defect in one item is logged; the item waits, and the pass goes on. */
    const guarded = (what: string, effect: Effect.Effect<Step>): Effect.Effect<Step> =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.as(Effect.logError(what, cause), "deferred" as const),
        ),
      );

    const runnerPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        yield* transaction(runs.settle);
        const now = yield* DateTime.now;
        for (const raw of yield* attemptRows) {
          const attempt = Schema.decodeUnknownOption(Attempt)(raw);
          if (Option.isNone(attempt)) {
            yield* Effect.logError("A routine run could not be read; it is tried again later");
            outcome.until(DateTime.addDuration(now, DEFECT_RETRY));
            continue;
          }
          const { retry_at: retryAt } = attempt.value;
          if (retryAt !== null && DateTime.isGreaterThan(retryAt, now)) {
            outcome.until(retryAt);
            continue;
          }
          const step = yield* guarded(
            "A routine run could not be started; it is tried again later",
            advance(attempt.value),
          );
          if (step === "unavailable") return { _tag: "unavailable" } as const;
          if (step === "deferred") outcome.defer();
        }
        for (const session of yield* spentRows) {
          const step = yield* guarded(
            "A routine's side session could not be retired; it is tried again later",
            retire(session),
          );
          if (step === "unavailable") return { _tag: "unavailable" } as const;
          if (step === "deferred") outcome.defer();
        }
        return outcome.done();
      }).pipe(Effect.withSpan("RoutineRunner.pass")),
    );

    const run = reconcile({
      name: "The routine runner",
      pass: runnerPass,
      signal: signals.routines,
      readiness,
    });

    return RoutineRunner.of({ pass: Effect.asVoid(runnerPass), run });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
