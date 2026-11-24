// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot's save-login card is a new kind of entry, `credential-request`, which
// the check on `entries.kind` refuses. SQLite cannot change a check, and the
// usual rebuild of a table drops it, which deletes the rows of every table
// that references an entry (`ON DELETE CASCADE`) or clears their links: a
// migration runs in a transaction, where foreign keys cannot be turned off.
// So the column is replaced in place, the table and its rows staying where
// they are: a new column with the wider check, filled from the old one, which
// is dropped, and the new one takes its name. The trigger that keeps a kind
// fixed names the column, so it goes first and comes back as it was.
//
// An added `NOT NULL` column needs a default, so `kind` has one from now on.
// It is never used: every entry is written with its kind.
//
// The list keeps `browser-help`, the browser help card, which migration 0024
// adds.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER entries_fixed_place`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'message' CHECK (
      entry_kind IN (
        'message', 'question', 'approval', 'secret-request', 'browser-help', 'credential-request',
        'work-fold', 'notice', 'handoff', 'routine-change'
      )
    )
  `;
  yield* sql`UPDATE entries SET entry_kind = kind`;
  yield* sql`ALTER TABLE entries DROP COLUMN kind`;
  yield* sql`ALTER TABLE entries RENAME COLUMN entry_kind TO kind`;
  yield* sql`
    CREATE TRIGGER entries_fixed_place
    BEFORE UPDATE OF conversation_bot_id, room_id, position, kind ON entries
    BEGIN
      SELECT RAISE(ABORT, 'an entry keeps its target, its place and its kind');
    END
  `;
});
