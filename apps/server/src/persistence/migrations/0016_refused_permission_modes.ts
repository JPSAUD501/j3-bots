// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine can refuse a bot's permission mode for good, as an
// administrator's policy on its machine does: the bot's main session is then
// neither opened nor aligned again until the bot's settings change
// (`bots/EngineSessions.ts`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The bot's `settings_revision` whose permission mode the engine refused,
  // and which its conversation was told of. A later revision is tried again.
  yield* sql`ALTER TABLE bots ADD COLUMN mode_refused_revision INTEGER`;
});
