// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  Label,
  ProviderId,
  RoutineId,
  RoutineInstruction,
  type RoutineRunFailure,
  RoutineRunId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import { Engine, IdempotencyKey, isBackgroundWorkPending, SessionId } from "@j3-bots/engine-t3";
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
import { ChangeLog } from "../persistence/ChangeLog.ts";
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
import { providerLimit } from "../turns/providerLimit.ts";
import { sessionLoss } from "../turns/sessionRecords.ts";
import { stopTargets } from "../turns/stopTargets.ts";
import { isIdle, sessionWork } from "../turns/sessionWork.ts";
import { Signals } from "../turns/Signals.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { dueToTell, RoutineRuns } from "./RoutineRuns.ts";
import { recordRunFailure } from "./runFailure.ts";

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
  due_at: Schema.NullOr(Time),
  started_at: Time,
  routine_id: RoutineId,
  name: Label,
  instruction: RoutineInstruction,
  trigger_json: json(RoutineTrigger),
});
type Attempt = typeof Attempt.Type;

const SideSession = Schema.Struct({
  id: SessionRowId,
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
});

/**
 * A live side session whose attempt has ended, or that the engine lost, and
 * whether it is superseded: a retry of its attempt is due to start, or a
 * newer run of its routine has started.
 */
const Spent = Schema.Struct({
  id: SessionRowId,
  engine_session_id: Schema.NullOr(SessionId),
  lost: Schema.BooleanFromBit,
  superseded: Schema.BooleanFromBit,
});
type Spent = typeof Spent.Type;

const EarlierRun = Schema.Struct({
  wake_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["delivered", "silent", "failed", "skipped"]),
  note: Schema.NullOr(Schema.String),
  started_at: Time,
});

/**
 * What one item of a pass came to: done, or waiting on a signal; left for a
 * pass shortly; held until a time; or stopped by an engine that is down.
 */
type Step =
  | "done"
  | "deferred"
  | "unavailable"
  | { readonly _tag: "until"; readonly at: DateTime.Utc | null };

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
 * may record a run's next attempt; retires every side session whose attempt
 * ended, once the engine shows nothing left running there; opens a side
 * session for every attempt that is due, once the attempt it retries has its
 * session out of use and the bot's provider is not at its usage limit; and
 * writes the attempt's dispatch once the session's events are known and a
 * turn slot is free.
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
    const runFailed = recordRunFailure(sql);
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
    const settings = yield* SettingsStore;
    const random = yield* SecureRandom.SecureRandom;
    const changes = yield* ChangeLog;
    const { admitsStart } = admission(sql, settings);
    const limitOf = providerLimit(sql, engineState);
    const workOf = sessionWork(sql);
    const zoneOf = operatorZone(settings);
    const { sessionLost } = sessionLoss(sql, entries, ledger, yield* WorkSteps, signals);
    const targets = stopTargets(sql);

    const attemptRows = sql`
      SELECT w.id AS wake_id, w.bot_id, r.id AS run_id, r.retry_at, r.trigger_data, r.due_at,
        r.started_at, ro.id AS routine_id, ro.name, ro.instruction, ro.trigger_json
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
        SELECT id, engine_session_id, provider_id FROM sessions
        WHERE side_wake_id = ${wakeId} AND retired_at IS NULL AND lost_at IS NULL
      `,
    });

    /**
     * Whether the attempt this wake retries still has a side session in use,
     * where it may yet run: a send of it whose answer was lost may land
     * there, or work it left may still go on. A retired one is in use until
     * the engine archived it, which nudges the runner.
     */
    const retriedStillLive = (wakeId: string) =>
      sql`
        SELECT 1 FROM wakes w JOIN sessions s ON s.side_wake_id = w.retry_of
        WHERE w.id = ${wakeId} AND s.lost_at IS NULL AND s.engine_retired_at IS NULL
          AND (s.retired_at IS NULL OR s.engine_session_id IS NOT NULL)
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    const spentRows = SqlSchema.findAll({
      Request: Schema.String,
      Result: Spent,
      execute: (now) => sql`
        SELECT s.id, s.engine_session_id, s.lost_at IS NOT NULL AS lost,
          EXISTS (
            SELECT 1 FROM wakes n JOIN routine_runs r ON r.wake_id = n.id
            WHERE n.retry_of = s.side_wake_id AND n.status = 'pending'
              AND r.retry_at IS NOT NULL AND r.retry_at <= ${now}
          )
          -- A newer run's first wake comes after every wake of the runs
          -- before it: a run is skipped while the one before is going.
          OR EXISTS (
            SELECT 1 FROM wakes n JOIN sessions ns ON ns.side_wake_id = n.id
            WHERE n.routine_id = w.routine_id AND n.retry_of IS NULL AND n.rowid > w.rowid
          ) AS superseded
        FROM sessions s
        LEFT JOIN wakes w ON w.id = s.side_wake_id
        WHERE s.purpose = 'side' AND s.retired_at IS NULL
          AND (s.lost_at IS NOT NULL OR w.id IS NULL
            OR w.status IN ('finished', 'cancelled', 'failed'))
        ORDER BY s.rowid
      `,
    });

    /**
     * Live side sessions written before a change of their bot's model or
     * permission mode, with nothing sent there, or a send given back unsent
     * (`EngineSessions.settingsChanged`).
     */
    const staleRows = sql<{ readonly id: string }>`
      SELECT s.id FROM sessions s JOIN bots b ON b.id = s.bot_id
      WHERE s.purpose = 'side' AND s.retired_at IS NULL AND s.lost_at IS NULL
        AND s.settings_revision < b.settings_revision
        AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.session_id = s.id AND d.attempts > 0)
      ORDER BY s.rowid
    `.pipe(Effect.orDie);

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
     * The attempt's envelope: the routine, its trigger data, when the run was
     * due if that was a while ago or on another day, and as many of its
     * earlier runs as fit the engine's input limit, newest first. A run was due at its schedule's
     * time, or when a webhook or the operator asked for it: a run that
     * started late, or an attempt tried again later, still does the work of
     * that time.
     */
    const envelopeOf = Effect.fn("RoutineRunner.envelopeOf")(function* (attempt: Attempt) {
      const recent = yield* recentRuns(attempt);
      const now = yield* DateTime.now;
      const due = attempt.due_at ?? attempt.started_at;
      const timeZone = yield* zoneOf;
      const base = {
        at: now,
        timeZone,
        sinceLastTurn: [],
        kind: "routine",
        routine: {
          id: attempt.routine_id,
          name: attempt.name,
          trigger: envelopeTrigger(attempt.trigger_json),
          instruction: attempt.instruction,
        },
        triggerData: attempt.trigger_data,
        dueAt: dueToTell(due, now, timeZone),
      } as const;
      for (let count = recent.length; count > 0; count--) {
        const wake: RoutineWake = { ...base, recentRuns: recent.slice(0, count) };
        if (fitsEngine(wake)) return { wake, fits: true };
      }
      const alone: RoutineWake = { ...base, recentRuns: [] };
      return { wake: alone, fits: fitsEngine(alone) };
    });

    /**
     * The attempt's side session, written now if it has none, while its wake
     * still waits, on the provider the bot's settings choose, read in the same
     * transaction. The first one written for the wake starts the attempt,
     * which the run counts. One not opened yet whose bot moved to another
     * provider never opens: it is retired, and a fresh one replaces it.
     */
    const sideSession = Effect.fn("RoutineRunner.sideSession")(function* (attempt: Attempt) {
      return yield* transaction(
        Effect.gen(function* () {
          const found = yield* bots.find(attempt.bot_id);
          if (Option.isNone(found)) return Option.none();
          const providerId = found.value.bot.model.providerId;
          const at = timeText(yield* DateTime.now);
          const existing = yield* sideSessionOf(attempt.wake_id);
          if (Option.isSome(existing)) {
            const { id, engine_session_id, provider_id } = existing.value;
            if (engine_session_id !== null || provider_id === providerId) return existing;
            yield* sql`UPDATE sessions SET retired_at = ${at} WHERE id = ${id}`;
          }
          const pending = yield* sql`
            SELECT 1 FROM wakes WHERE id = ${attempt.wake_id} AND status = 'pending'
          `;
          if (pending.length === 0) return Option.none();
          const earlier =
            yield* sql`SELECT 1 FROM sessions WHERE side_wake_id = ${attempt.wake_id}`;
          if (earlier.length === 0) {
            yield* sql`
              UPDATE routine_runs SET attempts = attempts + 1
              WHERE id = ${attempt.run_id} AND status = 'running'
            `;
            yield* changes.record({ _tag: "routines", botId: attempt.bot_id }, attempt.routine_id);
          }
          // It takes no part in their alignment (`settings_pending`): it
          // records the bot's settings revision now, and is replaced once the
          // bot is past it. Opened later, with settings no older than these.
          const id = SessionRowId.make(yield* ids.make("session"));
          yield* sql`
            INSERT INTO sessions (
              id, bot_id, purpose, prompt_version, provider_id, settings_pending,
              settings_revision, created_at, side_wake_id
            ) VALUES (
              ${id}, ${attempt.bot_id}, 'side', ${PROMPT_VERSION}, ${providerId}, 0,
              (SELECT settings_revision FROM bots WHERE id = ${attempt.bot_id}), ${at},
              ${attempt.wake_id}
            )
          `;
          return Option.some({ id, engine_session_id: null, provider_id: providerId });
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * Opens the side session in the engine, in the bot's project, with the
     * bot's model and permission mode, on the provider its row names. The
     * row's id is the request's key, so a retried opening returns the same
     * engine session, with the settings of its first attempt. An opening the
     * engine refused fails the attempt unsent, and its retry opens a fresh
     * side session, under a key of its own, as every new attempt does. A
     * refusal with a rejected receipt spends the key; one of the bot's
     * permission mode leaves no receipt and spends nothing, and is what the
     * run's history names.
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
        const failure = opened.failure;
        switch (failure._tag) {
          case "EngineUnavailable":
            return "unavailable";
          case "EngineIndeterminate":
          case "EngineIncompatible":
            // Not now: the engine's answer was lost, or it is not the one
            // pinned. The same key is sent again.
            yield* Effect.logWarning("A routine's side session could not be opened yet", {
              routineId: attempt.routine_id,
              reason: failure._tag,
            });
            return "deferred";
          case "ModelUnavailable":
          case "OpenRejected":
          case "PermissionModeRefused":
            // The engine does not offer the bot's model, refused the opening
            // and keeps that refusal for the key, or refuses the bot's
            // permission mode: the attempt fails, and the run tries again
            // after its delay, as for a failed turn. A refused permission
            // mode is what the run's history names.
            // Its dispatch is certainly never sent, yet fails `unresolved`:
            // `rejected` would fail the run at once, and a routine's
            // envelope consumes nothing a failure would have to give back.
            yield* Effect.logWarning("The engine refused to open a routine's side session", {
              routineId: attempt.routine_id,
              reason: failure._tag,
            });
            yield* writeDispatch(attempt, sessionId, {
              runFailure:
                failure._tag === "PermissionModeRefused"
                  ? {
                      _tag: "permission-mode-refused",
                      permissionMode: failure.permissionMode,
                      allowed: failure.allowed,
                    }
                  : null,
            });
            return "done";
        }
      }
      yield* sql`
        UPDATE sessions SET engine_session_id = ${opened.success}
        WHERE id = ${sessionId} AND engine_session_id IS NULL
      `.pipe(Effect.orDie);
      return "done";
    });

    /**
     * Writes the attempt's dispatch into its side session, in one transaction
     * that finds the wake still waiting and the session still live and opened
     * with its bot's settings as they stand. The dispatcher sends it. One
     * already ends the attempt unsent, failed `unresolved` for a session the
     * engine refused to open (`unopened`), which the run tries again, with
     * the reason its history names, if any, and `rejected` for an envelope
     * the engine would refuse, which fails the run. Its run settles from the
     * failed wake as for any other.
     */
    const writeDispatch = Effect.fn("RoutineRunner.writeDispatch")(function* (
      attempt: Attempt,
      sessionId: SessionRowId,
      unopened: { readonly runFailure: RoutineRunFailure | null } | null,
    ): Effect.fn.Return<Step> {
      const { wake, fits } = yield* envelopeOf(attempt);
      const failure = unopened !== null ? "unresolved" : fits ? null : "rejected";
      const runFailure = unopened?.runFailure ?? null;
      const envelope = yield* renderWake(wake).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      yield* transaction(
        Effect.gen(function* () {
          const still = yield* sql`
            SELECT 1 FROM wakes w JOIN sessions s ON s.side_wake_id = w.id
            JOIN bots b ON b.id = s.bot_id
            WHERE w.id = ${attempt.wake_id} AND w.status = 'pending' AND s.id = ${sessionId}
              AND s.retired_at IS NULL AND s.lost_at IS NULL
              AND s.settings_revision = b.settings_revision
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
          if (runFailure !== null) yield* runFailed(id, runFailure);
          if (failure !== null) {
            yield* ledger.fail(id, failure, { _tag: "failed", reason: failure });
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
      // The attempt it retries may still be running: one attempt at a time.
      // Its session's archive in the engine nudges the runner.
      if (yield* retriedStillLive(attempt.wake_id)) return "done";
      // A provider at its usage limit holds automated wakes until its reset.
      const limit = yield* limitOf(found.value.bot.model.providerId);
      if (Option.isSome(limit)) return { _tag: "until", at: limit.value.resetsAt };
      const session = yield* sideSession(attempt);
      if (Option.isNone(session)) return "done";
      const { id } = session.value;
      if (session.value.engine_session_id === null) {
        // Read again: a session opens only on the provider its row names. A
        // bot moved since is given a fresh one on the next pass.
        const current = yield* bots.find(attempt.bot_id);
        if (Option.isNone(current)) return "done";
        if (current.value.bot.model.providerId !== session.value.provider_id) return "deferred";
        const opened = yield* openInEngine(attempt, current.value, id);
        if (opened !== "done") return opened;
      }
      // Nothing is planned, and no slot taken, before the session's events are known.
      yield* observer.watch(id);
      if (!(yield* observer.ready(id))) return "deferred";
      // A routine waits for a free slot like any other start; the dispatcher
      // nudges nobody here when one frees, so the runner looks again shortly.
      if (!(yield* admitsStart(id))) return "deferred";
      return yield* writeDispatch(attempt, id, null);
    });

    /**
     * A side session written before its bot's model or permission mode
     * changed, with nothing sent there: no turn ever starts there with
     * settings the operator replaced. Its dispatch, if one waits unsent, is
     * released, so its wake waits again, and it is retired, in one
     * transaction. The attempt then gets a fresh session, opened with the
     * settings as they stand, and is not counted again. Nothing can be sent
     * there meanwhile: a first send's claim refuses a session behind its bot.
     */
    const replaceStale = Effect.fn("RoutineRunner.replaceStale")(function* (sessionId: string) {
      yield* transaction(
        Effect.gen(function* () {
          const sent = yield* sql`
            SELECT 1 FROM dispatches WHERE session_id = ${sessionId} AND attempts > 0
          `;
          if (sent.length > 0) return;
          const unsent = yield* sql<{ readonly id: string }>`
            SELECT id FROM dispatches WHERE session_id = ${sessionId} AND status = 'intended'
          `;
          for (const { id } of unsent) {
            const row = yield* ledger.find(DispatchRowId.make(id));
            if (Option.isSome(row)) {
              yield* ledger.release(
                row.value.id,
                yield* targets.wakesAfter(row.value, { _tag: "unsent" }),
              );
            }
          }
          yield* sql`
            UPDATE sessions SET retired_at = ${timeText(yield* DateTime.now)}
            WHERE id = ${sessionId} AND retired_at IS NULL
          `;
          yield* sql.afterCommit(signals.rotations.fire);
          yield* sql.afterCommit(signals.routines.fire);
        }),
      ).pipe(Effect.orDie);
      return "done" as const;
    });

    /**
     * Records a spent side session retired, once nothing of it can still run:
     * no turn or dispatch the server knows of, no Stop unsettled, checked
     * again in the transaction that retires it, and the engine's own account
     * shows no turn it can still run and no background work. Background work
     * stops holding it once it is superseded: a retry of its attempt is due,
     * and runs after the failed attempt is out of use, or a newer run of its
     * routine has started, which has its own session. The archive then ends
     * that work, as a replaced main session's does. A session never opened,
     * or lost, is retired at once. The rotator then archives the engine
     * thread and stops following its events, as for a replaced main session
     * (`turns/Rotations.ts`).
     */
    const retire = Effect.fn("RoutineRunner.retire")(function* (
      session: Spent,
    ): Effect.fn.Return<Step> {
      const quiet = Effect.map(
        workOf(session.id),
        (work) => isIdle(work) && work.continuations === 0 && !work.stopUnsettled,
      );
      const record = transaction(
        Effect.gen(function* () {
          if (!session.lost && session.engine_session_id !== null && !(yield* quiet)) return;
          yield* sql`
            UPDATE sessions SET retired_at = ${timeText(yield* DateTime.now)}
            WHERE id = ${session.id} AND retired_at IS NULL
          `;
          yield* sql.afterCommit(signals.rotations.fire);
        }),
      ).pipe(Effect.orDie);
      if (session.lost || session.engine_session_id === null) {
        yield* record;
        return "done";
      }
      // Still at work: the turn's end, or the Stop's confirmation, nudges the runner.
      if (!(yield* quiet)) return "done";
      const synced = yield* observer
        .synchronize(session.id, session.engine_session_id)
        .pipe(Effect.result);
      if (synced._tag === "Failure") {
        switch (synced.failure._tag) {
          case "EngineUnavailable":
            return "unavailable";
          case "SessionNotFound":
            // The engine has no such session, archived from its console say:
            // recorded lost, which nudges the runner to retire it. Its event
            // stream may still be open, and nothing else closes it.
            yield* transaction(sessionLost(session.id));
            yield* observer.close(session.id);
            return "done";
          default:
            return "deferred";
        }
      }
      if (synced.success.runnableTurns.length > 0) return "done";
      // Background work the run left running, a dev server say, keeps its
      // session until it ends, or until a retry of its failed attempt is due
      // or a newer run of its routine has started.
      if (isBackgroundWorkPending(synced.success.backgroundWork)) {
        if (!session.superseded) return "done";
        yield* Effect.logInfo(
          "A routine attempt's background work ends with its session, superseded by a newer attempt",
        );
      }
      yield* record;
      return "done";
    });

    /** What the pass makes of one item's step; whether the engine is down. */
    const noted = (step: Step, outcome: ReturnType<typeof passOutcome>) => {
      if (step === "unavailable") return true;
      if (step === "deferred") outcome.defer();
      else if (step !== "done") outcome.until(step.at);
      return false;
    };

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
        for (const { id } of yield* staleRows) {
          const step = yield* guarded(
            "A routine's side session opened with old settings could not be replaced",
            replaceStale(id),
          );
          if (noted(step, outcome)) return { _tag: "unavailable" } as const;
        }
        // Retired first: an attempt that retries waits for the one before it to be out of use.
        const spent = yield* spentRows(timeText(yield* DateTime.now)).pipe(Effect.orDie);
        for (const session of spent) {
          const step = yield* guarded(
            "A routine's side session could not be retired; it is tried again later",
            retire(session),
          );
          if (noted(step, outcome)) return { _tag: "unavailable" } as const;
        }
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
          if (noted(step, outcome)) return { _tag: "unavailable" } as const;
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
