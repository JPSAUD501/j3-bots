// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A wake a bot's work for a room caused records that work: the bot and the
// room its turn spoke for (docs/architecture/server.md, Stop). A member's
// turn in one room can post in another, and the room's Stop then cancels
// the wakes that post wrote there, and refuses them when they would wait
// again. Plain text, as a Stop keeps its room: the room may be deleted, and
// its Stop still tells its work from another room's. Wakes from before carry
// none, as nothing recorded which turn caused them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE wakes ADD COLUMN cause_bot_id TEXT`;
  yield* sql`ALTER TABLE wakes ADD COLUMN cause_room_id TEXT`;
  yield* sql`
    CREATE INDEX wakes_cause_room ON wakes (cause_room_id, cause_bot_id)
    WHERE cause_room_id IS NOT NULL
  `;
});
