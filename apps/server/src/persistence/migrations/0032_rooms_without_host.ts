// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A room has no host, and no hop limit (decision 0039): a message that
// mentions members wakes only them, one that mentions nobody wakes every
// member but its author, and a room counts its bots' messages since the
// operator last wrote there, which quiets them past a fixed number.
//
// `rooms.host_bot_id` and `rooms.hop_limit` go, and `rooms.bot_streak`, that
// count, comes. SQLite refuses to drop a column a table check names, and one
// does (an active room kept a host), so the table is rebuilt as SQLite
// describes it: a new table in the final shape, the rows copied, the old one
// dropped and the new one renamed in its place. The migrator runs with
// foreign keys off and checks them before it commits (`migrate`), so dropping
// the old table deletes nothing that references a room, and every reference
// names the new table once it takes the name. No index or trigger is on
// `rooms`, and none names it. Every room's count starts at nothing: until
// now, the room's hop limit was what bounded its bots.
//
// A room wake keeps what it told its member, in the new words: woken as the
// host for a message to nobody, it is the operator's message to the room
// (`user`); mentioned, it is `addressed`; `everyone` and a kickoff stay.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE rooms_without_host (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      read_through_order INTEGER,
      bot_streak INTEGER NOT NULL DEFAULT 0 CHECK (bot_streak >= 0),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'archived') = (archived_at IS NOT NULL))
    )
  `;
  yield* sql`
    INSERT INTO rooms_without_host (
      id, name, status, pinned, read_through_order, archived_at, created_at, updated_at
    )
    SELECT id, name, status, pinned, read_through_order, archived_at, created_at, updated_at
    FROM rooms
  `;
  yield* sql`DROP TABLE rooms`;
  yield* sql`ALTER TABLE rooms_without_host RENAME TO rooms`;

  yield* sql`
    UPDATE wakes SET payload_json = json_set(
      payload_json,
      '$.reason',
      CASE json_extract(payload_json, '$.reason') WHEN 'host' THEN 'user' ELSE 'addressed' END
    )
    WHERE kind = 'room' AND json_extract(payload_json, '$._tag') = 'room'
      AND json_extract(payload_json, '$.reason') IN ('host', 'mentioned')
  `;
});
