// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Two things the engine tells of a running turn (docs/architecture/server.md,
// Budgets and Sessions). `dispatches.steer_taken`: the turn a steer rides has
// taken it (`steer-taken`), so the operator's word counts there; a steer
// written before this migration counts as it did, from the engine's
// acceptance. `delegated_results`: each delegated task's report the engine
// steered into a turn of another audience, once its wake for the audience
// whose turn delegated the task is recorded, so a replay records none again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE dispatches ADD COLUMN steer_taken INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE dispatches SET steer_taken = 1 WHERE delivery = 'steer'`;
  yield* sql`
    CREATE TABLE delegated_results (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_result_id TEXT NOT NULL,
      PRIMARY KEY (session_id, engine_result_id)
    )
  `;
});
