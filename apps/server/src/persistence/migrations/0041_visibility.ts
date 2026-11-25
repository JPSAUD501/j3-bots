// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Bots and rooms are visible or hidden (decision 0050). A room is now hidden
// as a bot already could be. Each records the bot that made it, with
// `create_bot` or `start_room`, kept while that bot exists, and whether the
// operator chose its visibility: they did for whatever they made or showed
// and hid, and then no bot changes it. Every bot and room from before counts
// as the operator's choice: they have had it in their list, and nothing says
// which bot made it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN made_by_bot_id TEXT REFERENCES bots (id) ON DELETE SET NULL`;
  yield* sql`
    ALTER TABLE bots ADD COLUMN visibility_by_operator INTEGER NOT NULL DEFAULT 1
      CHECK (visibility_by_operator IN (0, 1))
  `;
  yield* sql`ALTER TABLE rooms ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))`;
  yield* sql`ALTER TABLE rooms ADD COLUMN made_by_bot_id TEXT REFERENCES bots (id) ON DELETE SET NULL`;
  yield* sql`
    ALTER TABLE rooms ADD COLUMN visibility_by_operator INTEGER NOT NULL DEFAULT 1
      CHECK (visibility_by_operator IN (0, 1))
  `;
});
