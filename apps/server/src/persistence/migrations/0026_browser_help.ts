// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot's browser help card is a new kind of entry, `browser-help`, which the
// check on `entries.kind` refuses. SQLite cannot change a check, and the
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
// `browser_help_cards` holds what the card's entry does not show: the turn
// that asked, where its answer wakes the bot, the engine's tab, and when the
// card stops waiting. The engine's tab id never leaves the server.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER entries_fixed_place`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'message' CHECK (
      entry_kind IN (
        'message', 'question', 'approval', 'secret-request', 'browser-help', 'work-fold',
        'notice', 'handoff', 'routine-change'
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

  // One row per card. `audience` is the turn's that asked, which the answer
  // wakes the bot for; the card itself is always in the bot's conversation.
  // `origin_seq` is the dispatch that began that turn's work, so a Stop that
  // covers the work also drops the wake an expiry would send.
  yield* sql`
    CREATE TABLE browser_help_cards (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      origin_seq INTEGER,
      engine_tab_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      closed_at TEXT,
      follow_up_wake_id TEXT UNIQUE REFERENCES wakes (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL)
    )
  `;
  yield* sql`
    CREATE INDEX browser_help_cards_open ON browser_help_cards (bot_id) WHERE closed_at IS NULL
  `;
});
