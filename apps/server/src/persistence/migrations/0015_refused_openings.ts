// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine keeps a refusal for the key it was sent under, so a session it
// refused to open is opened again under a fresh key (`bots/EngineSessions.ts`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // How many openings of the session the engine refused. Its key is its id
  // until then, and its id with this count after. A session left unopened by
  // an earlier release starts at zero, and the engine's refusal of its old
  // key, if it made one, counts the first.
  yield* sql`ALTER TABLE sessions ADD COLUMN open_refusals INTEGER NOT NULL DEFAULT 0`;
  // Whether the bot's conversation was told that its main session could not
  // be made ready. Cleared once it is.
  yield* sql`
    ALTER TABLE bots ADD COLUMN unready_told INTEGER NOT NULL DEFAULT 0
      CHECK (unready_told IN (0, 1))
  `;
});
