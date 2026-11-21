// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Work tracked by the turn that started it (`docs/architecture/server.md`,
// Stop, and decision 0013).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The turn of the same session whose work this one continues: the one a
  // usage limit's continuation resumes, or the one whose background work woke
  // the session, when the engine names it. A turn takes its audience from it,
  // and counts its hops and its Stops with it.
  yield* sql`ALTER TABLE turns ADD COLUMN origin_turn_id TEXT`;

  // Whether background work this turn started may still run, as the engine
  // last reported it: set when the turn ends handing off to such work, and
  // again from each report of the session's pending work, which clears it
  // once the engine no longer lists the turn. A room's Stop targets a session
  // while one of the room's turns there has it set.
  yield* sql`
    ALTER TABLE turns ADD COLUMN background_pending INTEGER NOT NULL DEFAULT 0
      CHECK (background_pending IN (0, 1))
  `;
  yield* sql`
    CREATE INDEX turns_background_pending ON turns (session_id)
    WHERE background_pending = 1
  `;
  // The hop count a turn the engine starts for work it does not name takes
  // from the turns with work flagged when it is admitted, kept so the turns
  // that go on with its own work count from it after those flags cleared.
  yield* sql`ALTER TABLE turns ADD COLUMN borrowed_hops INTEGER`;

  // A turn ended while turns of the session had background work flagged: the
  // Stop runner asks the engine for a report once nothing runs, which clears
  // the flags of work that ended. A report taken while nothing runs or waits
  // is the check; the end of a turn that ran or waited makes it due again.
  yield* sql`
    ALTER TABLE sessions ADD COLUMN background_check_due INTEGER NOT NULL DEFAULT 0
      CHECK (background_check_due IN (0, 1))
  `;

  // When a room's Stop round was first held back by work of another audience
  // that the server cannot see run, while nothing it sees run held it: past a
  // bound from then, the round goes regardless (`ROOM_ROUND_HOLD_BOUND`).
  yield* sql`ALTER TABLE stop_targets ADD COLUMN held_since TEXT`;
});
