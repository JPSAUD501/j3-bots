// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot asks the operator's word before it adds a connector that needs it
// (decision 0068): one at an address in the operator's own network, or a
// gallery entry that signs in with an app the operator registers. It asks
// through a new kind of entry, `connector-ask`, which the check on
// `entries.kind` refuses: the column is replaced in place, as migration 0042
// replaced it, with every kind 0042 allows and the new one, and what names
// `kind` goes first and comes back as it was.
//
// `connector_asks` holds one row per ask, as `secret_asks` does for an ask
// for a secret: the audience of the turn that asked, which its outcome wakes
// the bot for; the dispatch that began that turn's work, so a Stop of the
// work drops the wake an expiry would send; when it expires, and how it
// closed. What the bot asked to add is not stored: its address or its values
// can carry a key, which the server keeps only with its secrets. It waits in
// the server's memory, so an ask the server restarted under closes as
// expired.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TEMP TABLE kept_room_rounds AS
    SELECT id, room_round FROM entries WHERE room_round IS NOT NULL
  `;
  yield* sql`DROP TRIGGER entries_fixed_place`;
  yield* sql`DROP TRIGGER entries_fixed_round`;
  yield* sql`DROP TRIGGER pair_messages_gone`;
  yield* sql`DROP INDEX entries_room_word`;
  yield* sql`ALTER TABLE entries DROP COLUMN room_round`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'message' CHECK (
      entry_kind IN (
        'message', 'question', 'approval', 'secret-request', 'browser-help', 'secret-ask',
        'work-fold', 'notice', 'handoff', 'routine-change', 'connector-suggestion',
        'connector-auth', 'connector-input', 'connector-ask'
      )
    )
  `;
  yield* sql`UPDATE entries SET entry_kind = kind`;
  yield* sql`ALTER TABLE entries DROP COLUMN kind`;
  yield* sql`ALTER TABLE entries RENAME COLUMN entry_kind TO kind`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN room_round INTEGER
      CHECK (room_round IS NULL OR (room_round >= 0 AND room_id IS NOT NULL AND kind = 'message'))
  `;
  yield* sql`
    UPDATE entries
    SET room_round = (SELECT k.room_round FROM kept_room_rounds k WHERE k.id = entries.id)
    WHERE id IN (SELECT id FROM kept_room_rounds)
  `;
  yield* sql`DROP TABLE kept_room_rounds`;
  yield* sql`
    CREATE TRIGGER entries_fixed_round
    BEFORE UPDATE OF room_round ON entries
    WHEN OLD.room_round IS NOT NULL AND NEW.room_round IS NOT OLD.room_round
    BEGIN
      SELECT RAISE(ABORT, 'a room message keeps its round');
    END
  `;
  yield* sql`CREATE INDEX entries_room_word ON entries (room_id, position) WHERE room_round = 0`;
  yield* sql`
    CREATE TRIGGER pair_messages_gone
    BEFORE DELETE ON entries
    WHEN OLD.kind = 'handoff'
    BEGIN
      DELETE FROM pair_messages
      WHERE (sent_entry_id = OLD.id AND received_entry_id IS NULL)
        OR (received_entry_id = OLD.id AND sent_entry_id IS NULL);
    END
  `;
  yield* sql`
    CREATE TRIGGER entries_fixed_place
    BEFORE UPDATE OF conversation_bot_id, room_id, position, kind ON entries
    BEGIN
      SELECT RAISE(ABORT, 'an entry keeps its target, its place and its kind');
    END
  `;

  yield* sql`
    CREATE TABLE connector_asks (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      origin_seq INTEGER,
      expires_at TEXT NOT NULL,
      closed_at TEXT,
      closing TEXT CHECK (closing IN ('added', 'declined', 'failed', 'expired')),
      follow_up_wake_id TEXT UNIQUE REFERENCES wakes (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK ((closed_at IS NULL) = (closing IS NULL))
    )
  `;
  yield* sql`
    CREATE INDEX connector_asks_open ON connector_asks (expires_at) WHERE closed_at IS NULL
  `;
});
