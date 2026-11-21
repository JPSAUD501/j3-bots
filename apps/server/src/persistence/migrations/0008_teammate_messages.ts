// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One teammate message: the `message_bot` call that sent it, which names
  // the sender's session, turn and audience, and the cards it put in the two
  // conversations. An urgent message's wakes name the received card as their
  // source; a held message names it as its handoff. `stop_id` is the Stop that
  // reached the sending turn while it ran: what the message has not delivered
  // yet is cancelled then, and wherever it would wait again. The recipient's
  // id outlives the recipient, as a sender's does.
  yield* sql`
    CREATE TABLE handoffs (
      tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls (id) ON DELETE CASCADE,
      recipient_bot_id TEXT NOT NULL,
      sent_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      received_entry_id TEXT UNIQUE REFERENCES entries (id) ON DELETE SET NULL,
      stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL
    )
  `;
  yield* sql`CREATE INDEX handoffs_stopped ON handoffs (stop_id) WHERE stop_id IS NOT NULL`;

  // The latest Stop recorded while the turn ran, with the turn in its scope.
  // It covers the turn's work also when no dispatch began the turn, as for a
  // turn the engine started on its own.
  yield* sql`ALTER TABLE turns ADD COLUMN stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL`;
});
