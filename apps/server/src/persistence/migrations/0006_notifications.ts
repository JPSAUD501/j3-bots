// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether the server notifies at all. On by default: a device still shows
// nothing until the operator lets it, so the switch only ever silences.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1
      CHECK (notifications_enabled IN (0, 1))
  `;
});
