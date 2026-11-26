// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What the engine reports of a running turn and a session beyond their steps
// (decision 0072). `turns.retrying` is whether the engine is trying the
// turn's AI again after a failure, which the bot's state says while it runs
// (`turn-retrying`). `sessions.stop_ignored_turn_id` is the engine's turn
// whose stop its AI did not confirm in time, for which clients offer Force
// stop (`stop-ignored`); null when none. `sessions.force_stop_turn_id` is
// that turn once the operator pressed Force stop, until the engine took it
// or the turn ended without it (`Stops`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE turns ADD COLUMN retrying INTEGER NOT NULL DEFAULT 0 CHECK (retrying IN (0, 1))
  `;
  yield* sql`ALTER TABLE sessions ADD COLUMN stop_ignored_turn_id TEXT`;
  yield* sql`ALTER TABLE sessions ADD COLUMN force_stop_turn_id TEXT`;
});
