// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine notices a session showed the operator (decision 0083), one row
// per kind of notice, so each shows once per working session however often
// the engine repeats it or a replacement lists it again. `kind` is the
// notice's own key (`asks-before-acting:full-access`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE engine_notices (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      PRIMARY KEY (session_id, kind)
    )
  `;
});
