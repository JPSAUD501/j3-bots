// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Running routines in side sessions (`docs/architecture/server.md`, Routines).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How many times the run was tried: an attempt that failed before the bot
  // said anything is tried again, in a fresh side session, with a new wake
  // (`routines/RoutineRuns.ts`). The run's `wake_id` is its latest attempt's.
  yield* sql`
    ALTER TABLE routine_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1)
  `;
  // When the next attempt may start; null when no attempt waits for a time.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN retry_at TEXT`;
  // A run is found by the wake of its attempt.
  yield* sql`CREATE INDEX routine_runs_wake ON routine_runs (wake_id) WHERE wake_id IS NOT NULL`;

  // The routine wake a side session was opened for. Each attempt of a run
  // gets one live side session; a session lost before the attempt reached
  // the engine is replaced by a fresh one for the same wake.
  yield* sql`ALTER TABLE sessions ADD COLUMN side_wake_id TEXT REFERENCES wakes (id)`;
  yield* sql`
    CREATE UNIQUE INDEX sessions_side_wake ON sessions (side_wake_id)
    WHERE side_wake_id IS NOT NULL AND retired_at IS NULL AND lost_at IS NULL
  `;
});
