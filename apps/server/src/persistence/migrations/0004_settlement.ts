// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Two settlement fixes. See `docs/architecture/server.md`.
//
// A dispatch the engine answered for (a disposition, a turn) may still fail as
// `unresolved`: its session was lost before the turn ran, so the recovery can
// never learn more. The initial schema forbade any failed dispatch to carry
// the engine's answer, so recording that loss rolled back. The engine's first
// answer stays immutable (`dispatches_first_disposition`); a dispatch it
// refused (`rejected`) still never carries one. SQLite cannot change a CHECK
// in place: the table is rebuilt the documented way, which needs foreign keys
// off outside the migration's transaction (`Sqlite.ts`).
//
// `stop_targets.retry_at` is when the Stop runner tries a session again after
// its work there failed unexpectedly: a durable deadline like every other
// worker's, not a retry on each pass.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE dispatches_rebuilt (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('start', 'steer')),
      steer_turn_id TEXT,
      fresh_context INTEGER NOT NULL DEFAULT 0 CHECK (fresh_context IN (0, 1)),
      envelope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'intended', 'accepted', 'delivered', 'finished', 'dropped', 'released', 'failed'
        )
      ),
      failure_reason TEXT CHECK (failure_reason IN ('rejected', 'unresolved')),
      disposition TEXT CHECK (disposition IN ('started', 'queued', 'steered', 'new-turn')),
      disposition_turn_id TEXT,
      engine_turn_id TEXT,
      continuation_resumes_at TEXT,
      fenced_by_stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL,
      outcome_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      indeterminate_answers INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      staging_failures INTEGER NOT NULL DEFAULT 0 CHECK (staging_failures >= 0),
      closed_by TEXT CHECK (closed_by IN ('done', 'ask', 'handoff')),
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK ((delivery = 'steer') = (steer_turn_id IS NOT NULL)),
      CHECK (delivery = 'start' OR fresh_context = 0),
      CHECK (
        disposition IS NULL
        OR (delivery = 'start' AND disposition IN ('started', 'queued'))
        OR (delivery = 'steer' AND disposition IN ('steered', 'new-turn'))
      ),
      CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
      CHECK (disposition IS NULL OR status NOT IN ('intended', 'released')),
      CHECK ((disposition IS NULL) = (disposition_turn_id IS NULL)),
      CHECK (engine_turn_id IS NULL OR status NOT IN ('intended', 'released')),
      CHECK (
        failure_reason IS NOT 'rejected' OR (disposition IS NULL AND engine_turn_id IS NULL)
      ),
      CHECK (status NOT IN ('delivered', 'finished', 'dropped') OR engine_turn_id IS NOT NULL),
      CHECK (continuation_resumes_at IS NULL OR status = 'delivered'),
      CHECK (
        continuation_resumes_at IS NULL
        OR NOT (delivery = 'steer' AND engine_turn_id = steer_turn_id)
      )
    )
  `;
  yield* sql`
    INSERT INTO dispatches_rebuilt (
      id, bot_id, session_id, audience, audience_room_id, delivery, steer_turn_id,
      fresh_context, envelope, status, failure_reason, disposition, disposition_turn_id,
      engine_turn_id, continuation_resumes_at, fenced_by_stop_id, outcome_json, attempts,
      created_at, updated_at, indeterminate_answers, next_attempt_at, staging_failures, closed_by
    )
    SELECT
      id, bot_id, session_id, audience, audience_room_id, delivery, steer_turn_id,
      fresh_context, envelope, status, failure_reason, disposition, disposition_turn_id,
      engine_turn_id, continuation_resumes_at, fenced_by_stop_id, outcome_json, attempts,
      created_at, updated_at, indeterminate_answers, next_attempt_at, staging_failures, closed_by
    FROM dispatches
  `;
  yield* sql`DROP TABLE dispatches`;
  yield* sql`ALTER TABLE dispatches_rebuilt RENAME TO dispatches`;

  yield* sql`
    CREATE TRIGGER dispatches_immutable_intent
    BEFORE UPDATE OF session_id, audience, delivery, steer_turn_id, fresh_context, envelope
    ON dispatches
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the session, audience and envelope it was written with');
    END
  `;
  yield* sql`
    CREATE TRIGGER dispatches_first_disposition
    BEFORE UPDATE OF disposition, disposition_turn_id ON dispatches
    WHEN OLD.disposition IS NOT NULL
      AND (NEW.disposition IS NOT OLD.disposition
        OR NEW.disposition_turn_id IS NOT OLD.disposition_turn_id)
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the engine''s first answer');
    END
  `;
  yield* sql`
    CREATE INDEX dispatches_open ON dispatches (session_id, status)
    WHERE status IN ('intended', 'accepted', 'delivered')
  `;
  yield* sql`
    CREATE TRIGGER dispatches_rider_keeps_turn
    BEFORE UPDATE OF engine_turn_id ON dispatches
    WHEN OLD.delivery = 'steer' AND OLD.engine_turn_id = OLD.steer_turn_id
      AND OLD.status <> 'accepted'
      AND NEW.engine_turn_id IS NOT OLD.engine_turn_id
    BEGIN
      SELECT RAISE(ABORT, 'a steer finishes with the turn it rode');
    END
  `;
  yield* sql`
    CREATE UNIQUE INDEX dispatches_turn ON dispatches (session_id, engine_turn_id)
    WHERE engine_turn_id IS NOT NULL
      AND NOT (delivery = 'steer' AND engine_turn_id = steer_turn_id)
  `;

  // The rebuild ran with foreign keys off: nothing may point nowhere.
  const dangling = yield* sql`PRAGMA foreign_key_check`;
  if (dangling.length > 0) {
    return yield* Effect.die(new Error("Rebuilding dispatches left a foreign key unsatisfied"));
  }

  yield* sql`ALTER TABLE stop_targets ADD COLUMN retry_at TEXT`;
});
