// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

/**
 * Whether the room has a turn or dispatch live, which holds its next wake
 * (`docs/architecture/server.md`, Rooms): a turn of the room not finished, or
 * a dispatch of it about to be sent, in the engine's hands, or delivered with
 * its turn's work going on. A dispatch whose turn waits on a usage limit's
 * reset holds the room no more: its continuation is its own bot's, which
 * takes no automated wake until then, and the operator's word drops it; once
 * the engine resumes it, its turn holds the room again. `except` names a
 * dispatch that does not count, as the one whose send asks. The planner and
 * a start's claim read it with the same rule. `roomId` is often a caller's
 * column, so the tables here have aliases no caller uses.
 */
export const roomLiveSql = (
  sql: SqlClient.SqlClient,
  roomId: Statement.Fragment,
  except: Statement.Fragment = sql`NULL`,
) => sql`(
  EXISTS (
    SELECT 1 FROM dispatches rl_dispatch
    WHERE rl_dispatch.audience_room_id = ${roomId}
      AND rl_dispatch.id IS NOT ${except}
      AND (
        rl_dispatch.status IN ('intended', 'accepted')
        OR (rl_dispatch.status = 'delivered' AND rl_dispatch.continuation_resumes_at IS NULL)
      )
  )
  OR EXISTS (
    SELECT 1 FROM turns rl_turn
    WHERE rl_turn.audience_room_id = ${roomId} AND rl_turn.finished_at IS NULL
  )
)`;
