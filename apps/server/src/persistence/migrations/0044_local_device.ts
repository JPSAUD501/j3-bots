// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Which devices the admin channel signed in: the computer the server runs on,
// signed in by the desktop app with no pairing code. That computer has one
// such device at a time: each one the channel signs in revokes those before
// it, so one the app lost track of is never left signed in. Devices signed in
// before this was recorded are not marked; the app still names the one it kept.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE devices ADD COLUMN signed_in_locally INTEGER NOT NULL DEFAULT 0`;
});
