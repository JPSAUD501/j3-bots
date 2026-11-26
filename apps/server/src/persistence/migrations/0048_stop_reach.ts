// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What a room's Stop must reach that its turns' own rows did not show
// (docs/architecture/server.md, Stop).
//
// A wake a bot's work for one room caused in another records that work: the
// bot and the room its turn spoke for. The room's Stop then cancels the
// wakes that post wrote there, and refuses them when they would wait again.
// Plain text, as a Stop keeps its room: the room may be deleted, and its
// Stop still tells its work from another room's. Wakes from before carry
// none, as nothing recorded which turn caused them.
//
// A room turn that ended is unreported until the engine's next report of
// the session's background work: the engine can count work its end did not
// tell of, and until the report says whose it is, the room's Stop waits for
// it. Turns from before start reported, as their reports were taken.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE wakes ADD COLUMN cause_bot_id TEXT`;
  yield* sql`ALTER TABLE wakes ADD COLUMN cause_room_id TEXT`;
  yield* sql`
    CREATE INDEX wakes_cause_room ON wakes (cause_room_id, cause_bot_id)
    WHERE cause_room_id IS NOT NULL
  `;
  yield* sql`
    ALTER TABLE turns ADD COLUMN background_unreported INTEGER NOT NULL DEFAULT 0
      CHECK (background_unreported IN (0, 1))
  `;
  yield* sql`
    CREATE INDEX turns_background_unreported ON turns (session_id)
    WHERE background_unreported = 1
  `;
});
