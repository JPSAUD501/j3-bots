// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether a bot may use the engine's browser, which is off until the operator
// turns it on (`bots/EngineSessions.ts`). A session records whether its tools
// were brought to the browser setting its bot had then: a change reloads
// them before the session's next turn. Every bot from before starts with it
// off, as the engine, which now has it off everywhere, gives every session.
// A bot counts the times it lost the browser that are not yet withdrawn from
// its project's threads: nonzero until the withdrawal is done.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN browser INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE bots ADD COLUMN browser_withdrawals INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE sessions ADD COLUMN browser INTEGER NOT NULL DEFAULT 0`;
});
