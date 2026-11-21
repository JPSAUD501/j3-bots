// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Routine runs (`docs/architecture/server.md`, Routines).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The body of the webhook request that started the run, which the run's
  // envelope gives the bot as data; null for a run the schedule or the
  // operator started.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN trigger_data TEXT`;

  // The `Idempotency-Key` the webhook request carried. A request that repeats
  // a key of the routine's kept runs records nothing and is answered with the
  // run the first one recorded.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN request_key TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX routine_runs_request ON routine_runs (routine_id, request_key)
    WHERE request_key IS NOT NULL
  `;

  // A routine's runs still going: at most one, which a run coming due skips
  // behind. The scheduler settles each from its wake.
  yield* sql`
    CREATE UNIQUE INDEX routine_runs_running ON routine_runs (routine_id) WHERE status = 'running'
  `;

  // Wakes of a routine, found when it is deleted: what is still pending is cancelled.
  yield* sql`CREATE INDEX wakes_routine ON wakes (routine_id) WHERE routine_id IS NOT NULL`;
});
