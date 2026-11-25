// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether the server updates its own copies of Claude Code and Codex by
// itself, on unless the operator turns it off (`Settings.autoUpdateHarnesses`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN auto_update_harnesses INTEGER NOT NULL DEFAULT 1
      CHECK (auto_update_harnesses IN (0, 1))
  `;
});
