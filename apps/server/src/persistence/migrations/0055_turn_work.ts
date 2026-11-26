// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A turn keeps its plan and little ones (decision 0070): `work_json` holds
// them as the engine last told them, as `TurnWork` shows them, null for a
// turn that had neither. A turn of the bot's own conversation shows them on
// its work fold, a room's turn in the room while its work runs, so they are
// kept with the turn, which knows its audience, rather than with the fold.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE turns ADD COLUMN work_json TEXT`;
});
