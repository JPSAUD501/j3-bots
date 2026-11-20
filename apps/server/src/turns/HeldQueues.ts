// SPDX-License-Identifier: AGPL-3.0-or-later
import { Engine, EventCursor, SessionId } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
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
import { recoveryBackoff, SessionRowId } from "./model.ts";
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
  queue_held_cursor: EventCursor,
  queue_resume_failures: Schema.Int,
  queue_resume_at: Schema.NullOr(Time),
});
type Due = typeof Due.Type;

/** How one session's resume went. */
type Resume = "done" | "unavailable";

/**
 * Resumes held engine queues (`docs/architecture/server.md`, Held queues): a
 * reconciler over the holds the events reported. Each hold is resumed once,
 * through the session's gate, after the session's events are caught up, so a
 * replacement that shows the queue no longer held, or a hold replayed from
 * before, is applied before the hold is read. A resume whose reply was lost
 * is sent again for the same hold with backoff, for as long as that hold is
 * the session's current one: the engine applies a resume of one hold once. A
 * result is recorded only against the hold it answered. Nothing is resumed
 * while a Stop of the session is unsettled; its confirmation nudges this
 * worker.
 */
export class HeldQueues extends Context.Service<
  HeldQueues,
  {
    /** One pass over the holds that are due. */
    readonly resumePending: Effect.Effect<void>;
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

    /** A session whose hold is still to be resumed, and can be now. */
    const holdPending = sql`
      s.queue_held_cursor IS NOT NULL
        AND s.queue_held_cursor IS NOT s.queue_resumed_cursor
        AND s.lost_at IS NULL AND s.engine_session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
        )
    `;
    const HOLD_COLUMNS = `
      s.id, s.engine_session_id, s.queue_held_cursor, s.queue_resume_failures, s.queue_resume_at
    `;

    const dueHolds = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Due,
      execute: () => sql`
        SELECT ${sql.literal(HOLD_COLUMNS)} FROM sessions s WHERE ${holdPending} ORDER BY s.rowid
      `,
    })(undefined).pipe(Effect.orDie);

    /** The hold as it stands, if it is still to be resumed now. */
    const holdOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Due,
      execute: (sessionId) => sql`
        SELECT ${sql.literal(HOLD_COLUMNS)} FROM sessions s
        WHERE s.id = ${sessionId} AND ${holdPending}
      `,
    });

    const lost = (sessionId: SessionRowId) =>
      transaction(sessionLost(sessionId)).pipe(Effect.as("done" satisfies Resume as Resume));

    /**
     * The hold waits until `next` before its resume is sent again: its reply
     * was lost, or the resume failed unexpectedly. Recorded only while it is
     * still the session's current hold.
     */
    const later = Effect.fn("HeldQueues.later")(function* (hold: Due, next: DateTime.Utc) {
      yield* sql`
        UPDATE sessions SET queue_resume_failures = ${hold.queue_resume_failures + 1},
          queue_resume_at = ${timeText(next)}
        WHERE id = ${hold.id} AND queue_held_cursor = ${hold.queue_held_cursor}
      `.pipe(Effect.orDie);
      return "done" satisfies Resume as Resume;
    });

    /** The reply was lost: the same hold is resumed again with backoff, which the engine applies once. */
    const unanswered = Effect.fn("HeldQueues.unanswered")(function* (hold: Due) {
      const now = yield* DateTime.now;
      return yield* later(
        hold,
        DateTime.addDuration(now, recoveryBackoff(hold.queue_resume_failures + 1)),
      );
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
          // Only against the hold it answered: a newer one is resumed on its own.
          Effect.andThen(
            sql`
              UPDATE sessions SET queue_resumed_cursor = ${hold.queue_held_cursor},
                queue_resume_failures = 0, queue_resume_at = NULL
              WHERE id = ${sessionId} AND queue_held_cursor = ${hold.queue_held_cursor}
            `.pipe(Effect.orDie),
          ),
          Effect.as("done" satisfies Resume as Resume),
          Effect.catchTags({
            SessionNotFound: () => lost(sessionId),
            EngineIndeterminate: () => unanswered(hold),
            EngineUnavailable: () => Effect.succeed("unavailable" satisfies Resume as Resume),
            EngineIncompatible: () => Effect.succeed("unavailable" satisfies Resume as Resume),
          }),
        );
    });

    /** What one due hold's turn in the pass did. */
    type Step = "done" | "deferred" | "unavailable";

    /** Caught up, then resumed in the gate. */
    const resumeOne = Effect.fn("HeldQueues.resumeOne")(function* (hold: Due) {
      yield* observer.watch(hold.id);
      if (!(yield* observer.ready(hold.id))) return "deferred" satisfies Step as Step;
      // Caught up first: a replacement or a replayed hold is applied before
      // the hold is read in the gate. A catch-up that could not reach the
      // engine is this session's alone: the pass goes on with the others.
      const caughtUp = yield* observer.synchronize(hold.id, hold.engine_session_id).pipe(
        Effect.as("synced" as const),
        Effect.catchTags({
          SessionNotFound: () => Effect.as(lost(hold.id), "lost" as const),
          NotObserved: () => Effect.succeed("deferred" as const),
          EngineIndeterminate: () => Effect.succeed("deferred" as const),
          EngineUnavailable: () => Effect.succeed("deferred" as const),
          EngineIncompatible: () => Effect.succeed("unavailable" as const),
        }),
      );
      if (caughtUp === "unavailable" || caughtUp === "deferred") return caughtUp;
      if (caughtUp === "lost") return "done" satisfies Step as Step;
      return yield* gate.run(hold.id)(resumeInGate(hold.id));
    });

    /**
     * One hold at a time: a defect is logged and that hold is resumed again
     * on the backoff of a lost reply, while the pass goes on with the others.
     */
    const supervised = (hold: Due) =>
      resumeOne(hold).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError(
              "A held queue could not be resumed; it is tried again later",
              cause,
            ).pipe(Effect.andThen(unanswered(hold))),
        ),
      );

    const pass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        for (const hold of yield* dueHolds) {
          if (hold.queue_resume_at !== null && DateTime.isGreaterThan(hold.queue_resume_at, now)) {
            continue;
          }
          const step = yield* supervised(hold);
          if (step === "unavailable") return { _tag: "unavailable" } as const;
          if (step === "deferred") outcome.defer();
        }
        for (const hold of yield* dueHolds) outcome.until(hold.queue_resume_at);
        return outcome.done();
      }).pipe(Effect.withSpan("HeldQueues.resumePending")),
    );

    return HeldQueues.of({
      resumePending: Effect.asVoid(pass),
      run: reconcile({ name: "The held-queue resumer", pass, signal: signals.resumes, readiness }),
    });
  }),
);
