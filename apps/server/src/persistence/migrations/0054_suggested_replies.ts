// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Suggested replies (decision 0073). The operator's switch, on unless they
// turn it off (`Settings.suggestReplies`). And, for each turn, the newest
// message it said in its bot's conversation: a reply the AI suggests after a
// turn is offered only while that message is the newest entry there.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN suggest_replies INTEGER NOT NULL DEFAULT 1
      CHECK (suggest_replies IN (0, 1))
  `;
  yield* sql`
    ALTER TABLE turns ADD COLUMN said_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL
  `;
});
