// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A connector's app is part of the bot's reply (decision 0093): an entry of a
// new kind, `connector-app`, in the conversation or room the turn speaks to,
// where the call happened, in place of a line in the turn's work fold. The
// check on `entries.kind` refuses it, so the column is replaced in place, as
// migration 0062 replaced it, with every kind 0062 allows and the new one.
//
// A view now names the turn whose call opened it (`session_id`,
// `engine_turn_id`), which counts the apps a turn shows, and `entry_id` is
// the app's own entry. A view kept before names its turn's fold, whose list
// still shows it; it names no turn.
//
// `connector_app_contexts` holds what an app set as context for its bot
// (`ui/update-model-context`): one row per view, which the app's next update
// replaces, for the bot's next turn where the app is shown (`audience`, as a
// turn's). `consumed_dispatch_id` is the dispatch whose envelope carries it,
// as a catch-up note's: cleared again when that dispatch ends undelivered,
// and set back to null when the app sets something new.
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
        'connector-auth', 'connector-input', 'connector-ask', 'routine-run',
        'event-routine-change', 'event-routine-run', 'connector-app'
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

  yield* sql`ALTER TABLE connector_app_views ADD COLUMN session_id TEXT`;
  yield* sql`ALTER TABLE connector_app_views ADD COLUMN engine_turn_id TEXT`;
  yield* sql`
    CREATE INDEX connector_app_views_turn ON connector_app_views (session_id, engine_turn_id)
    WHERE session_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE connector_app_contexts (
      view_id TEXT PRIMARY KEY REFERENCES connector_app_views (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT,
      text TEXT NOT NULL,
      structured_json TEXT,
      updated_at TEXT NOT NULL,
      consumed_dispatch_id TEXT REFERENCES dispatches (id) ON DELETE SET NULL,
      CHECK ((audience = 'room') = (audience_room_id IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE INDEX connector_app_contexts_pending ON connector_app_contexts (bot_id, updated_at)
    WHERE consumed_dispatch_id IS NULL
  `;
});
