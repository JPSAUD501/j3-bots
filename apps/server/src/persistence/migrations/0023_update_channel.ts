// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Which releases the server is offered: `stable`, the default, or `nightly`
// (`releases/ReleaseFeed.ts`). Like any migration, it makes the release
// before refuse the database; going back to it restores the snapshot the
// update took (`j3-bots update --rollback`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'
      CHECK (update_channel IN ('stable', 'nightly'))
  `;
});
