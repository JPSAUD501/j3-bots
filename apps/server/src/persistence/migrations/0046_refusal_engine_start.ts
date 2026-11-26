// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A refusal of a bot's permission mode names the engine start that refused it
// (`docs/architecture/server.md`, Every bot has a main session): the engine
// reads its policy when it starts, and a start clears only the refusals of the
// starts before it, so one a new start gave before the server's startup caught
// up stands. A refusal from before has none, and the next start clears it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN mode_refused_engine_start INTEGER`;
});
