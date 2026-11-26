// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// When the server first asked the engine to open the session under its
// current key, written before the call (`bots/EngineSessions.ts`). A session
// retired before its engine id was recorded, after an answer that was lost
// or a crash, may still have a thread on the engine: the rotator asks again
// under the same key, records the id, and archives it. Cleared when the
// engine refuses the key, which leaves no thread. A session written by an
// earlier release has none, and is retired as it was.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN open_requested_at TEXT`;
});
