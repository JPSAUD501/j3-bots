// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A room of bots only (decision 0103): a bot's `start_room` may leave the
// operator out, and then they read it and never write in it. Every room from
// before had the operator in it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE rooms ADD COLUMN bots_only INTEGER NOT NULL DEFAULT 0 CHECK (bots_only IN (0, 1))
  `;
});
