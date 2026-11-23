// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A routine whose runs came due while the server was not running makes up the
// latest of them only while it is nearer than the next one, and counts the
// rest as missed (`routines/schedule.ts`, `catchUp`). Like any migration, it
// makes the release before refuse the database, which records a migration
// that release does not know; going back to it restores the snapshot the
// update took (`j3-bots update --rollback`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The time a scheduled run was due, which it started at or after; NULL for
  // a run a webhook or the operator asked for, and for one recorded before.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN due_at TEXT`;
  // The runs missed since the routine's last run started, as JSON
  // `{count, since, until}`; NULL when none.
  yield* sql`ALTER TABLE routines ADD COLUMN missed_json TEXT`;
});
