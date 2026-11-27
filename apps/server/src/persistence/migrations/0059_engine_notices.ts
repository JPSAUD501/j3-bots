// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine notices a bot showed the operator (decision 0083), one row per
// kind of notice and the model the bot had then, so each shows once for each
// model the bot has, whichever of its sessions the engine says it in, however
// often it repeats it, and however often a replacement lists it again. `kind`
// is the notice's own key (`asks-before-acting:full-access`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE engine_notices (
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (bot_id, kind, provider_id, model_id)
    )
  `;
});
