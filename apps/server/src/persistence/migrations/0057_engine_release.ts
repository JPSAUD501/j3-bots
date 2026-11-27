// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine release that last ran on this home's engine data
// (`EngineRelease`). The engine migrates its own data forward and an older
// engine starts on that data all the same, so the server refuses to start one
// older than this. No row: none recorded yet, as for a database from before
// this migration.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE engine_release (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});
