// SPDX-License-Identifier: AGPL-3.0-or-later
import { Engine, EventCursor, SessionId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { Ledger } from "./Ledger.ts";
import { MAX_RESUME_TRIES, recoveryBackoff, SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
import { SessionGate } from "./SessionGate.ts";
import { sessionLoss } from "./sessionRecords.ts";
import { Signals } from "./Signals.ts";
import { WorkSteps } from "./WorkSteps.ts";

/** A hold not resumed yet, in a session that can take its resume. */
const Due = Schema.Struct({
  id: SessionRowId,
  engine_session_id: SessionId,
  queue_resume_at: Schema.NullOr(Time),
});

const HoldRow = Schema.Struct({
  engine_session_id: SessionId,
  queue_held_cursor: EventCursor,
  queue_resume_failures: Schema.Int,
  queue_resume_at: Schema.NullOr(Time),
});

/** How one session's resume went. */
type Resume = "done" | "unavailable";

/**
 * Resumes held engine queues (`docs/architecture/server.md`, Held queues): a
 * reconciler over the holds the events reported. Each hold is resumed once,
 * through the session's gate, after the session's events are caught up, so a
 * replacement that shows the queue no longer held, or a hold replayed from
 * before, is applied before the hold is read. A resume whose reply was lost
 * is tried again with backoff, a bounded number of times, and then at the
 * engine's next ready edge. Nothing is resumed while a Stop of the session is
 * unsettled; its confirmation nudges this worker.
 */
export class HeldQueues extends Context.Service<
  HeldQueues,
  {
    /** One pass over the holds that are due. */
    readonly resumePending: Effect.Effect<void>;
    /** At a ready edge: every hold whose resumes went unanswered is tried afresh. */
    readonly retryExhausted: Effect.Effect<void>;
    /** The resumer, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/HeldQueues") {}

export const layer = Layer.effect(
  HeldQueues,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const observer = yield* Observer;
    const gate = yield* SessionGate;
    const signals = yield* Signals;
    const readiness = yield* Readiness;
    const { sessionLost } = sessionLoss(
      sql,
      yield* Entries,
      yield* Ledger,
      yield* WorkSteps,
      signals,
    );

    const dueHolds = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Due,
      execute: () => sql`
        SELECT s.id, s.engine_session_id, s.queue_resume_at FROM sessions s
        WHERE s.queue_held_cursor IS NOT NULL
          AND s.queue_held_cursor IS NOT s.queue_resumed_cursor
          AND s.lost_at IS NULL AND s.engine_session_id IS NOT NULL
          AND s.queue_resume_failures < ${MAX_RESUME_TRIES}
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
          )
        ORDER BY s.rowid
      `,
    })(undefined).pipe(Effect.orDie);

    /** The hold as it stands, if it is still to be resumed now. */
    const holdOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: HoldRow,
      execute: (sessionId) => sql`
        SELECT s.engine_session_id, s.queue_held_cursor, s.queue_resume_failures,
          s.queue_resume_at
        FROM sessions s
        WHERE s.id = ${sessionId} AND s.queue_held_cursor IS NOT NULL
          AND s.queue_held_cursor IS NOT s.queue_resumed_cursor
          AND s.lost_at IS NULL AND s.engine_session_id IS NOT NULL
          AND s.queue_resume_failures < ${MAX_RESUME_TRIES}
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
          )
      `,
    });

    const lost = (sessionId: SessionRowId) =>
      transaction(sessionLost(sessionId)).pipe(Effect.as("done" satisfies Resume as Resume));

    /** The resume's reply was lost: tried again with backoff, then at the next ready edge. */
    const unanswered = Effect.fn("HeldQueues.unanswered")(function* (
      sessionId: SessionRowId,
      failures: number,
      now: DateTime.Utc,
    ) {
      const next =
        failures >= MAX_RESUME_TRIES
          ? null
          : timeText(DateTime.addDuration(now, recoveryBackoff(failures)));
      if (next === null) {
        yield* Effect.logWarning(
          "A held queue's resume got no answer; it is resumed on the next ready edge",
        );
      }
      yield* sql`
        UPDATE sessions SET queue_resume_failures = ${failures}, queue_resume_at = ${next}
        WHERE id = ${sessionId}
      `.pipe(Effect.orDie);
      return "done" satisfies Resume as Resume;
    });

    /** One resume, read and recorded inside the gate. */
    const resumeInGate = Effect.fn("HeldQueues.resumeInGate")(function* (sessionId: SessionRowId) {
      const found = yield* holdOf(sessionId).pipe(Effect.orDie);
      if (Option.isNone(found)) return "done" satisfies Resume;
      const hold = found.value;
      const now = yield* DateTime.now;
      if (hold.queue_resume_at !== null && DateTime.isGreaterThan(hold.queue_resume_at, now)) {
        return "done" satisfies Resume;
      }
      return yield* engine
        .resumeQueue({ sessionId: hold.engine_session_id, hold: hold.queue_held_cursor })
        .pipe(
          Effect.andThen(
            sql`
              UPDATE sessions SET queue_resumed_cursor = ${hold.queue_held_cursor},
                queue_resume_failures = 0, queue_resume_at = NULL
              WHERE id = ${sessionId}
            `.pipe(Effect.orDie),
          ),
          Effect.as("done" satisfies Resume as Resume),
          Effect.catchTags({
            SessionNotFound: () => lost(sessionId),
            // The reply was lost: the same hold is resumed again later, which
            // the engine applies once.
            EngineIndeterminate: () => unanswered(sessionId, hold.queue_resume_failures + 1, now),
            EngineUnavailable: () => Effect.succeed("unavailable" satisfies Resume as Resume),
            EngineIncompatible: () => Effect.succeed("unavailable" satisfies Resume as Resume),
          }),
        );
    });

    const pass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        for (const row of yield* dueHolds) {
          if (row.queue_resume_at !== null && DateTime.isGreaterThan(row.queue_resume_at, now)) {
            continue;
          }
          if (!(yield* observer.ready(row.id))) {
            outcome.defer();
            continue;
          }
          // Caught up first: a replacement or a replayed hold is applied before
          // the hold is read in the gate.
          const caughtUp = yield* observer.synchronize(row.id, row.engine_session_id).pipe(
            Effect.as("synced" as const),
            Effect.catchTags({
              SessionNotFound: () => Effect.as(lost(row.id), "lost" as const),
              NotObserved: () => Effect.succeed("deferred" as const),
              EngineIndeterminate: () => Effect.succeed("deferred" as const),
              EngineUnavailable: () => Effect.succeed("unavailable" as const),
              EngineIncompatible: () => Effect.succeed("unavailable" as const),
            }),
          );
          if (caughtUp === "unavailable") return { _tag: "unavailable" } as const;
          if (caughtUp === "deferred") outcome.defer();
          if (caughtUp !== "synced") continue;
          const resumed = yield* gate.run(row.id)(resumeInGate(row.id));
          if (resumed === "unavailable") return { _tag: "unavailable" } as const;
        }
        for (const row of yield* dueHolds) outcome.until(row.queue_resume_at);
        return outcome.done();
      }).pipe(Effect.withSpan("HeldQueues.resumePending")),
    );

    const retryExhausted = sql`
      UPDATE sessions SET queue_resume_failures = 0, queue_resume_at = NULL
      WHERE queue_resume_failures > 0 OR queue_resume_at IS NOT NULL
    `.pipe(Effect.orDie, Effect.asVoid);

    return HeldQueues.of({
      resumePending: Effect.asVoid(pass),
      retryExhausted,
      run: reconcile({ name: "The held-queue resumer", pass, signal: signals.resumes, readiness }),
    });
  }),
);
