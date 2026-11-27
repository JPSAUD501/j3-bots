// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot's effort (decision 0082): the level of reasoning effort the operator
// chose for its model, as the engine names it, or null for the harness's own
// default, which every bot had before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN effort TEXT`;
});
