// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A push about a bot's request for help in its browser no longer shows the
// bot's note (docs/architecture/server.md, "Push delivery"). One written
// before, and not sent yet, still has the note as its preview: it goes with
// the fixed sentence instead.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE push_deliveries SET body = plain_body
    WHERE status = 'pending'
      AND entry_id IN (SELECT id FROM entries WHERE kind = 'browser-help')
  `;
});
