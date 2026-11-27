// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who made a bot, for its card to say (decision 0102): the operator, or one
// of their bots with `create_bot`. `made_by_bot_id` alone cannot say: it goes
// back to null when that bot is deleted, as it is for the operator's. A bot
// that records its maker made it; any other from before is left unknown, as
// nothing says whether the operator or a bot since deleted made it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN made_by TEXT CHECK (made_by IN ('operator', 'bot'))`;
  yield* sql`UPDATE bots SET made_by = 'bot' WHERE made_by_bot_id IS NOT NULL`;
});
