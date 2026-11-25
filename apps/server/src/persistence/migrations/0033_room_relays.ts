// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot's post in a room that relays the operator's request, from a turn they
// spoke in outside that room's own turns, starts the room's count of its
// bots' messages again, as their own message there would
// (docs/architecture/server.md, The room's count). Their word reaches each
// room once per turn: the turn's first such post records the turn here, and
// its later posts in that room count as the bot's own. A row goes with its
// room and with its turn.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE room_relays (
      room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      engine_turn_id TEXT NOT NULL,
      PRIMARY KEY (room_id, session_id, engine_turn_id),
      FOREIGN KEY (session_id, engine_turn_id)
        REFERENCES turns (session_id, engine_turn_id) ON DELETE CASCADE
    )
  `;
  yield* sql`CREATE INDEX room_relays_turn ON room_relays (session_id, engine_turn_id)`;
});
