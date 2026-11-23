// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The bot's opening an operator's message waits behind: written while the
// hello waited for its provider, the message goes once the opening has ended,
// as the bot's next turn (`turns/Pipeline.ts`, `sendMessage`). Recorded in the
// transaction that writes the message's wake, so a later message, or the
// provider turning ready, cannot undo it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A wake written before this was recorded waits behind nothing.
  yield* sql`
    ALTER TABLE wakes ADD COLUMN behind_opening_id TEXT REFERENCES wakes (id) ON DELETE SET NULL
  `;
  yield* sql`
    CREATE INDEX wakes_behind_opening ON wakes (behind_opening_id)
      WHERE behind_opening_id IS NOT NULL
  `;
});
