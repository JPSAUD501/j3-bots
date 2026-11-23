// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether the bot runs the model the server chose for it, because none was
// named when it was created, rather than one the operator chose, and the same
// of its permission mode. Until its hello is sent, such a bot moves to the
// server's default model once that model's provider is ready, and to that
// model's default permission mode when the server chose that too
// (`bots/Bots.ts`, `adoptDefaults`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A bot created before this was recorded keeps its model and permission
  // mode: nothing tells whether the operator chose them, so they count as theirs.
  yield* sql`
    ALTER TABLE bots ADD COLUMN model_by_server INTEGER NOT NULL DEFAULT 0
      CHECK (model_by_server IN (0, 1))
  `;
  yield* sql`
    ALTER TABLE bots ADD COLUMN permission_mode_by_server INTEGER NOT NULL DEFAULT 0
      CHECK (permission_mode_by_server IN (0, 1))
  `;
});
