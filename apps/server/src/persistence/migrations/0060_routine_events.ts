// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A routine can run when a connector's server says an event happened (MCP's
// Events extension, decision 0088).
//
// Its changes are entries of a new kind, `event-routine-change`, which the
// check on `entries.kind` refuses: the column is replaced in place, as
// migration 0052 replaced it, with every kind 0052 allows and the new one.
//
// `routine_event_listeners` holds what J3 Bots keeps of each event routine's
// subscription, which the server holds, never the bot: the trigger it was
// made for (`trigger_key`), so a new trigger starts afresh; the cursor its
// server last gave, kept after each delivery, which it resumes from; whether
// events may have been missed since the routine last ran; whether it is
// listening, waiting for its connector, or stopped and why; and, when the
// server posts its events to J3 Bots, the address' token, the secret they are
// signed with, the subscription's id and when it must be renewed.
// `routine_event_seen` keeps the events already taken, by the server's id, so
// one delivered twice wakes the routine once. `routine_event_pending` holds
// the events that came while the routine's previous run went on, or past its
// rate, for its next run.
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
        'connector-auth', 'connector-input', 'connector-ask', 'event-routine-change'
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
    CREATE TABLE routine_event_listeners (
      routine_id TEXT PRIMARY KEY REFERENCES routines (id) ON DELETE CASCADE,
      trigger_key TEXT NOT NULL,
      cursor TEXT,
      missed INTEGER NOT NULL DEFAULT 0 CHECK (missed IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('listening', 'waiting', 'stopped')),
      stop_reason TEXT,
      state_since TEXT NOT NULL,
      webhook_token TEXT UNIQUE,
      webhook_secret TEXT,
      subscription_id TEXT,
      refresh_before TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((state = 'stopped') = (stop_reason IS NOT NULL)),
      CHECK ((webhook_token IS NULL) = (webhook_secret IS NULL))
    )
  `;
  yield* sql`
    CREATE TABLE routine_event_seen (
      routine_id TEXT NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (routine_id, event_id)
    )
  `;
  yield* sql`CREATE INDEX routine_event_seen_age ON routine_event_seen (routine_id, seen_at)`;
  yield* sql`
    CREATE TABLE routine_event_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id TEXT NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
      occurrence_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX routine_event_pending_routine ON routine_event_pending (routine_id, id)`;
});
