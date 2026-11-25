// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// How far a session was shown a room outside its envelopes
// (docs/architecture/server.md, What a bot has seen of a room): the room's
// newest entry when a call of the session read all it had not seen of the
// room, or was refused a post there and shown what it had missed. One row per
// call. `calls_known` is the newest of the session's engine tool calls known
// when the view was recorded (`engine_tool_calls.rowid`): a call already known
// then was written before the bot had the view, so the view does not count
// for it. A row goes with its room and with its turn.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE room_views (
      session_id TEXT NOT NULL,
      engine_call_id TEXT NOT NULL,
      engine_turn_id TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      through INTEGER NOT NULL CHECK (through >= 0),
      calls_known INTEGER NOT NULL,
      PRIMARY KEY (session_id, engine_call_id),
      FOREIGN KEY (session_id, engine_turn_id)
        REFERENCES turns (session_id, engine_turn_id) ON DELETE CASCADE
    )
  `;
  yield* sql`CREATE INDEX room_views_turn ON room_views (session_id, engine_turn_id)`;
  yield* sql`CREATE INDEX room_views_room ON room_views (room_id, session_id)`;
  // A stored refusal now says which it is (`Speech.ts`). Before, a
  // `message_bot` stored one only past the hop limit, and
  // `suggest_connector` one its checks refused.
  yield* sql`
    UPDATE tool_calls SET result_json = json_set(
      result_json, '$.kind',
      CASE tool WHEN 'message_bot' THEN 'hop-limit' ELSE 'connector' END
    )
    WHERE tool IN ('message_bot', 'suggest_connector')
      AND json_extract(result_json, '$._tag') = 'refused'
  `;
});
