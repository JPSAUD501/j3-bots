// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The vault becomes secrets (decision 0046).
//
// A bot's save-login card, `credential-request`, becomes its ask for a
// secret, `secret-ask`: a login or a single value, under the name the bot
// asked for, which closes saved, declined or expired and wakes the bot. The
// check on `entries.kind` is replaced in place, as migration 0026 says why,
// and every save-login card is rewritten as an ask for a login. A card that
// was saved keeps the name it was saved under; any other shows its site's
// host. A card still open closes as expired: nothing wakes its bot, which
// was never told it would be, and the operator adds the login from Secrets.
//
// `secret_asks` holds one row per ask, as `browser_help_cards` does for a
// browser help card: the audience of the turn that asked, which its outcome
// wakes the bot for; the dispatch that began that turn's work, so a Stop of
// the work drops the wake an expiry would send; when it expires, and how it
// closed.
//
// A bot no longer has a switch for filling logins: a secret's own grant is
// the permission (`bots.vault` goes).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE entries SET body_json = json_object(
      'name', CASE
        WHEN json_extract(body_json, '$.status._tag') = 'saved'
          THEN json_extract(body_json, '$.status.name')
        ELSE substr(
          json_extract(body_json, '$.origin'),
          instr(json_extract(body_json, '$.origin'), '://') + 3,
          200
        )
      END,
      'secret', json_object('_tag', 'login', 'origin', json_extract(body_json, '$.origin')),
      'note', json_extract(body_json, '$.note'),
      'status', json_object('_tag', CASE json_extract(body_json, '$.status._tag')
        WHEN 'saved' THEN 'saved'
        WHEN 'dismissed' THEN 'declined'
        ELSE 'expired'
      END)
    )
    WHERE kind = 'credential-request'
  `;

  // Everything that names `entries.kind` goes first, since SQLite refuses to
  // drop a column a trigger, an index or another column's check names, and
  // comes back after: the two triggers on it, and `room_round`, whose check
  // names it (migration 0034), with its trigger and index. `room_round` is
  // replaced in place too, its check naming the new column, which the rename
  // carries over.
  yield* sql`DROP TRIGGER entries_fixed_place`;
  yield* sql`DROP TRIGGER pair_messages_gone`;
  yield* sql`DROP TRIGGER entries_fixed_round`;
  yield* sql`DROP INDEX entries_room_word`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'message' CHECK (
      entry_kind IN (
        'message', 'question', 'approval', 'secret-request', 'browser-help', 'secret-ask',
        'work-fold', 'notice', 'handoff', 'routine-change', 'connector-suggestion',
        'connector-auth'
      )
    )
  `;
  yield* sql`
    UPDATE entries SET entry_kind = CASE kind
      WHEN 'credential-request' THEN 'secret-ask'
      ELSE kind
    END
  `;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_round INTEGER CHECK (
      entry_round IS NULL
      OR (entry_round >= 0 AND room_id IS NOT NULL AND entry_kind = 'message')
    )
  `;
  yield* sql`UPDATE entries SET entry_round = room_round`;
  yield* sql`ALTER TABLE entries DROP COLUMN room_round`;
  yield* sql`ALTER TABLE entries DROP COLUMN kind`;
  yield* sql`ALTER TABLE entries RENAME COLUMN entry_kind TO kind`;
  yield* sql`ALTER TABLE entries RENAME COLUMN entry_round TO room_round`;
  yield* sql`
    CREATE TRIGGER entries_fixed_place
    BEFORE UPDATE OF conversation_bot_id, room_id, position, kind ON entries
    BEGIN
      SELECT RAISE(ABORT, 'an entry keeps its target, its place and its kind');
    END
  `;
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
    CREATE TRIGGER entries_fixed_round
    BEFORE UPDATE OF room_round ON entries
    WHEN OLD.room_round IS NOT NULL AND NEW.room_round IS NOT OLD.room_round
    BEGIN
      SELECT RAISE(ABORT, 'a room message keeps its round');
    END
  `;
  yield* sql`CREATE INDEX entries_room_word ON entries (room_id, position) WHERE room_round = 0`;

  yield* sql`
    CREATE TABLE secret_asks (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      origin_seq INTEGER,
      expires_at TEXT NOT NULL,
      closed_at TEXT,
      closing TEXT CHECK (closing IN ('saved', 'declined', 'expired')),
      follow_up_wake_id TEXT UNIQUE REFERENCES wakes (id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK ((closed_at IS NULL) = (closing IS NULL))
    )
  `;
  yield* sql`
    CREATE INDEX secret_asks_open ON secret_asks (expires_at) WHERE closed_at IS NULL
  `;

  yield* sql`ALTER TABLE bots DROP COLUMN vault`;
});
