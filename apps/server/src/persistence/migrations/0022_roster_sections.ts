// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The roster's sections: named groups of bots, in the operator's order
// (`position`, renumbered from 0 whenever one moves). A bot is in at most one;
// deleting a section leaves its bots in none. Every bot starts in none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    ALTER TABLE bots ADD COLUMN section_id TEXT REFERENCES sections (id) ON DELETE SET NULL
  `;
  yield* sql`CREATE INDEX bots_section ON bots (section_id) WHERE section_id IS NOT NULL`;
});
