// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Room turns (`docs/architecture/server.md`, Rooms).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // For a room dispatch, the place of the room's newest entry when its
  // envelope was written: the member has seen the room through it once the
  // engine may have applied the dispatch. What a member has seen is derived
  // from these and the dispatches' status, so a dispatch the engine certainly
  // never applied leaves its entries unseen for the next envelope.
  yield* sql`ALTER TABLE dispatches ADD COLUMN room_through INTEGER`;
  yield* sql`DROP TRIGGER dispatches_immutable_intent`;
  yield* sql`
    CREATE TRIGGER dispatches_immutable_intent
    BEFORE UPDATE OF session_id, audience, delivery, steer_turn_id, fresh_context, envelope,
      room_through
    ON dispatches
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the session, audience and envelope it was written with');
    END
  `;
  yield* sql`
    CREATE INDEX dispatches_room_seen ON dispatches (audience_room_id, bot_id)
    WHERE room_through IS NOT NULL
  `;

  // A room runs one turn at a time: planning asks whether any dispatch or
  // turn of the room is live.
  yield* sql`
    CREATE INDEX dispatches_room_open ON dispatches (audience_room_id)
    WHERE audience_room_id IS NOT NULL AND status IN ('intended', 'accepted', 'delivered')
  `;
  yield* sql`
    CREATE INDEX turns_room_running ON turns (audience_room_id)
    WHERE audience_room_id IS NOT NULL AND finished_at IS NULL
  `;
  yield* sql`
    CREATE INDEX wakes_room_pending ON wakes (audience_room_id, priority)
    WHERE audience_room_id IS NOT NULL AND status = 'pending'
  `;
});
