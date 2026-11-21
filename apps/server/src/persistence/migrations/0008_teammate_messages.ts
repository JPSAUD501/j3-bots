// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One teammate message: the cards it put in the two conversations, and the
  // `message_bot` call that sent it, which names the sender's session, turn
  // and audience. It lives as long as the received card. An urgent message's
  // wakes name that card as their source; a held message names it as its
  // handoff. `stop_id` is the Stop that reached the sending turn while it
  // ran: what the message has not delivered yet is cancelled then, and
  // wherever it would wait again. It is only a mark, so that the sender's
  // deletion, which takes its call and its Stops with it, never undoes it.
  // The recipient's id outlives the recipient, as a sender's does.
  yield* sql`
    CREATE TABLE handoffs (
      received_entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      tool_call_id TEXT UNIQUE REFERENCES tool_calls (id) ON DELETE SET NULL,
      recipient_bot_id TEXT NOT NULL,
      sent_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      stop_id TEXT
    )
  `;
  yield* sql`CREATE INDEX handoffs_stopped ON handoffs (stop_id) WHERE stop_id IS NOT NULL`;

  // The latest Stop recorded while the turn ran, with the turn in its scope.
  // It covers the turn's work also when no dispatch began the turn, as for a
  // turn the engine started on its own.
  yield* sql`ALTER TABLE turns ADD COLUMN stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL`;

  // A held copy of the operator's Retry of an urgent message, which the
  // recipient's Stop cancelled: the Retry is the operator's word, so no Stop
  // of the sender removes it.
  yield* sql`ALTER TABLE held_messages ADD COLUMN retried INTEGER NOT NULL DEFAULT 0`;
});
