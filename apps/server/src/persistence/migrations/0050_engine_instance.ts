// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine the sessions and the bots' projects belong to
// (docs/architecture/server.md, "Sessions", "Another engine"). Every time the
// engine becomes ready, the server compares the engine it reaches with this
// row before it follows any session:
//
// - no row: none recorded yet, as for a database from before this migration,
//   whose sessions are the engine's it reaches now; that one is recorded;
// - `instance_id`: the engine they belong to. Another one, as a fresh data
//   directory starts, has none of them: every session it had is lost, every
//   bot's project is forgotten, and the new engine is recorded;
// - `instance_id` null: they belong to an engine this home does not have,
//   as after `j3-bots import`, which leaves the engine behind. Every session
//   is lost the same way.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE engine_instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id TEXT,
      recorded_at TEXT NOT NULL
    )
  `;
});
