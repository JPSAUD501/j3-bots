// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether the server may fill the vault's logins into a bot's browser tab
// (`vault/Fill.ts`), which is off until the operator turns it on. Every bot
// from before starts with it off.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN vault INTEGER NOT NULL DEFAULT 0`;
});
