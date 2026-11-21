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

  // A routine's receipts written before runs counted their attempts, so a
  // replay of one answers what it answered then: a run that had not started.
  yield* sql`
    UPDATE command_receipts SET result_json = json_set(result_json, '$.lastRun.attempts', 0)
    WHERE method IN ('routine.create', 'routine.update')
      AND json_type(result_json, '$.lastRun') = 'object'
  `;
});
