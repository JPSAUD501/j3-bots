// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A connector's tools are what its server lists, as it lists them (decision
// 0047): the review of changed tools goes, and with it `kept_revision`.
// `tools_json` becomes the tools its server listed last, each with its
// `_meta.ui` (null for those kept before, which its server lists again on
// its next session).
//
// A connector's server asks the operator through a new kind of entry,
// `connector-input`, which the check on `entries.kind` refuses: the column is
// replaced in place, as migration 0028 explains, with every kind 0037 allows
// and the new one. SQLite refuses to drop a column that a trigger, an index
// or another column's check names, so what names `kind` goes first and comes
// back as it was: the triggers `entries_fixed_place` (0028) and
// `pair_messages_gone` (0031), and `room_round` (0034), whose check names
// `kind`, with its trigger and its index. A room message's round is kept
// aside meanwhile and written back.
//
// A call to a connector's tool says, on its work step, which connector it is
// and the tool's `_meta.ui`, and while it runs how far it got:
// `connector_steps` keeps that by the engine session and the call, which is
// also the step's id, so the step keeps it whenever the engine writes it again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE connectors DROP COLUMN kept_revision`;
  yield* sql`
    UPDATE connectors SET tools_json = (
      SELECT json_group_array(json_set(value, '$.ui', json('null')))
      FROM json_each(connectors.tools_json)
    )
    WHERE tools_json IS NOT NULL
  `;

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
        'connector-auth', 'connector-input'
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
    CREATE TABLE connector_steps (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      ui_json TEXT,
      progress TEXT,
      PRIMARY KEY (session_id, call_id)
    )
  `;
});
