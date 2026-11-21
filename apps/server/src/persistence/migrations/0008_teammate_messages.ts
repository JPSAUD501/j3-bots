// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The teammate a `message_bot` call reached, so the fan-out limit can count
// the teammates one turn has messaged. Null for every other call, and for a
// message that was not sent. The id outlives the teammate, as a sender's does.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE tool_calls ADD COLUMN recipient_bot_id TEXT`;
});
