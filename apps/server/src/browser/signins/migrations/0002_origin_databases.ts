// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A store's baseline keeps what it held of an origin's databases apart from
// its `localStorage` (`databases`), so the two are brought together each on
// its own. SQLite cannot change a table's check, so the table is made again.
// An origin's digest from before named its storage whole, which no digest
// now matches: it becomes unknown (`''`), and the origin is brought together
// again as with a new host.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE store_entries_next (
      store TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('cookie', 'origin', 'databases')),
      id TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (store, kind, id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO store_entries_next
    SELECT store, kind, id, CASE kind WHEN 'origin' THEN '' ELSE digest END FROM store_entries
  `;
  yield* sql`DROP TABLE store_entries`;
  yield* sql`ALTER TABLE store_entries_next RENAME TO store_entries`;
});
