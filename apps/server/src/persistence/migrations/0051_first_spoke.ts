// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// When a bot first posted a message, in its conversation or in a room
// (docs/architecture/server.md, "First contact"): a bot made for a room is
// new to the operator until then. It outlives the room the message was in,
// which takes its entries with it. A bot from before this migration takes
// the time of its first message still kept.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN first_spoke_at TEXT`;
  yield* sql`
    UPDATE bots SET first_spoke_at = (
      SELECT MIN(created_at) FROM entries
      WHERE author_bot_id = bots.id AND kind = 'message'
    )
  `;
});
