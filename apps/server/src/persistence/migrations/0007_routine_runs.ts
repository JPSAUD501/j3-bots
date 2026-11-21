// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Running routines in side sessions (`docs/architecture/server.md`, Routines).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How many attempts of the run started: an attempt starts when its side
  // session is written, and one that failed before the bot said anything is
  // tried again, in a fresh side session, with a new wake
  // (`routines/RoutineRuns.ts`). The run's `wake_id` is its latest attempt's.
  // No run before this one ever started.
  yield* sql`
    ALTER TABLE routine_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
  `;
  // When the next attempt may start; null when no attempt waits for a time.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN retry_at TEXT`;
  // A run is found by the wake of its attempt.
  yield* sql`CREATE INDEX routine_runs_wake ON routine_runs (wake_id) WHERE wake_id IS NOT NULL`;

  // The routine wake a side session was opened for. Each attempt of a run
  // gets one live side session; a session lost before the attempt reached
  // the engine is replaced by a fresh one for the same wake. A session whose
  // wake is deleted with its bot is deleted right after it.
  yield* sql`
    ALTER TABLE sessions ADD COLUMN side_wake_id TEXT REFERENCES wakes (id) ON DELETE SET NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX sessions_side_wake ON sessions (side_wake_id)
    WHERE side_wake_id IS NOT NULL AND retired_at IS NULL AND lost_at IS NULL
  `;

  // How many times the bot's model or permission mode changed, and, for a
  // side session, how many times they had when its row was written. A first
  // send into a side session behind its bot is refused, and the routine
  // runner replaces the session (`bots/EngineSessions.ts`). Null for a main
  // session, which is aligned instead (`settings_pending`).
  yield* sql`ALTER TABLE bots ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE sessions ADD COLUMN settings_revision INTEGER`;

  // The position of the conversation entry a catch-up note reports (a
  // routine run's message), so a fresh start leaves out every note from
  // before it, also one an unsent dispatch gives back later
  // (`turns/rotationRequests.ts`). Null for a note that reports no entry.
  yield* sql`ALTER TABLE catch_up_notes ADD COLUMN source_position INTEGER`;

  // Whether a provider is at its usage limit is read from the newest turn
  // that completed or met the limit (`turns/providerLimit.ts`), on every pass
  // that plans automated work: read newest first, it stops at the first one.
  yield* sql`
    CREATE INDEX turns_limit_outcomes ON turns (finished_at)
    WHERE finished_at IS NOT NULL AND (json_extract(outcome_json, '$._tag') = 'completed'
      OR json_extract(outcome_json, '$.failure') = 'usage-limit')
  `;

  // A routine's receipts written before runs counted their attempts, so a
  // replay of one answers what it answered then: a run that had not started.
  yield* sql`
    UPDATE command_receipts SET result_json = json_set(result_json, '$.lastRun.attempts', 0)
    WHERE method IN ('routine.create', 'routine.update')
      AND json_type(result_json, '$.lastRun') = 'object'
  `;
});
