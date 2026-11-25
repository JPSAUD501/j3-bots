// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { hopCounts } from "./hopCounts.ts";
import type { SessionRowId } from "./model.ts";

/** A tool call of a session, as the engine recorded it. */
export interface SessionCall {
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
  readonly callId: string;
}

/** A turn of a session, which a room post comes from. */
export interface ShownTurn {
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
}

const Through = Schema.Struct({ through: Schema.NullOr(Schema.Int) });

/**
 * What a room was shown to a bot's sessions (`docs/architecture/server.md`,
 * What a bot has seen of a room), the one record both the room's rounds and
 * what a session has seen are read from. A room is shown to a turn of a
 * session by:
 *
 * - a room dispatch the engine took for it (`accepted`, `delivered` or
 *   `finished`), through the room's newest entry when its envelope was
 *   written, its reply taking the round the dispatch keeps;
 * - perhaps, a room dispatch the engine may have applied, one written and not
 *   yet taken, or whose recovery gave up (`intended`, or `failed` unresolved).
 *   The next envelope does not repeat what it showed, but nothing else counts
 *   it: it shows the room for sure only once the engine takes it. One
 *   released, dropped or refused never showed anything;
 * - a read of the room's newest messages that showed all the session had not
 *   seen, or a refused post, of one of its calls (`room_views`), through the
 *   room's newest entry then, its reply taking one round past the newest it
 *   showed since the operator's latest word. A view also keeps the newest of
 *   the session's tool calls the engine had recorded by then
 *   (`calls_known`): a call already recorded was written without it.
 *
 * A showing told the session how many older entries it left out, so the
 * session has seen the room through the furthest of its showings. Each
 * session has its own: what one was shown never reached another, a session
 * that replaced it included.
 */
export const roomShown = (sql: SqlClient.SqlClient) => {
  const { chainSql: chain } = hopCounts(sql);

  /**
   * Every showing of the room, as rows of the session, turn, place, round and
   * whether it surely showed the room (`sure`).
   */
  const showings = (roomId: RoomId) => sql`
    SELECT session_id, engine_turn_id, disposition_turn_id, steer_turn_id,
      room_through AS through, room_round AS round, NULL AS calls_known,
      status IN ('accepted', 'delivered', 'finished') AS sure
    FROM dispatches
    WHERE audience_room_id = ${roomId} AND status NOT IN ('released', 'dropped')
      AND NOT (status = 'failed' AND failure_reason = 'rejected')
    UNION ALL
    SELECT session_id, engine_turn_id, NULL, NULL, through, room_round, calls_known, 1
    FROM room_views WHERE room_id = ${roomId}
  `;

  /**
   * What the turn was shown of the room, for its round: how many showings
   * reached it and the turns whose work it goes on with (the turn a
   * continuation resumes, the one whose background work woke the session:
   * `hopCounts.chainSql`), a steer riding any of them included, and the
   * highest round their replies take among those that showed the room past
   * `from`, `null` when none did. A dispatch is the turn's it was first
   * answered for (`disposition_turn_id`) as well as the one it is now: a
   * continuation takes over its turn's dispatch, and the speech of the turn
   * it resumes may be read after that. A steer counts once the engine has
   * it: whether the agent read it is told only when the turn ends, so it is
   * taken as shown.
   */
  const shownToTurn = (roomId: RoomId, turn: ShownTurn, from: number) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ showings: Schema.Int, round: Schema.NullOr(Schema.Int) }),
      execute: () => sql`
        SELECT COUNT(*) AS showings, MAX(CASE WHEN through >= ${from} THEN round END) AS round
        FROM (${showings(roomId)})
        WHERE session_id = ${turn.sessionId} AND sure
          AND (
            engine_turn_id IN (${chain(turn.sessionId, turn.turnId)})
            OR disposition_turn_id IN (${chain(turn.sessionId, turn.turnId)})
            OR (
              engine_turn_id IS NULL
              AND steer_turn_id IN (${chain(turn.sessionId, turn.turnId)})
            )
          )
      `,
    })(undefined).pipe(Effect.orDie);

  /**
   * The place through which the session has seen the room, which its next
   * room envelope leaves out: the furthest of its showings, those that may
   * have shown it included, `null` for none.
   */
  const throughSession = (sessionId: SessionRowId, roomId: RoomId) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Through,
      execute: () => sql`
        SELECT MAX(through) AS through FROM (${showings(roomId)})
        WHERE session_id = ${sessionId}
      `,
    })(undefined).pipe(
      Effect.map((row) => row.through),
      Effect.orDie,
    );

  /**
   * The place through which the call's session had seen the room when the bot
   * wrote the call: the furthest of its sure showings but the views recorded
   * after the engine recorded the call. A call written beside a read, in the
   * same model message, was written without what the read showed.
   */
  const throughCall = (call: SessionCall, roomId: RoomId) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Through,
      execute: () => sql`
        SELECT MAX(through) AS through FROM (${showings(roomId)})
        WHERE session_id = ${call.sessionId} AND sure
          AND (
            calls_known IS NULL
            OR calls_known < (
              SELECT rowid FROM engine_tool_calls
              WHERE session_id = ${call.sessionId} AND engine_call_id = ${call.callId}
            )
          )
      `,
    })(undefined).pipe(
      Effect.map((row) => row.through),
      Effect.orDie,
    );

  /**
   * Records that the call was shown the room through `through`, its reply
   * taking one round past the newest it showed since the operator's latest
   * word there. The session's calls the engine recorded by now were written
   * before this view, so it counts only for later ones.
   */
  const record = (call: SessionCall, roomId: RoomId, through: number) =>
    sql`
      INSERT INTO room_views (
        session_id, engine_call_id, engine_turn_id, room_id, through, room_round, calls_known
      ) VALUES (
        ${call.sessionId}, ${call.callId}, ${call.turnId}, ${roomId}, ${through},
        (
          SELECT MAX(room_round) + 1 FROM entries
          WHERE room_id = ${roomId} AND room_round IS NOT NULL AND position <= ${through}
            AND position >= (
              SELECT COALESCE(MAX(position), 0) FROM entries
              WHERE room_id = ${roomId} AND room_round = 0
            )
        ),
        (SELECT COALESCE(MAX(rowid), 0) FROM engine_tool_calls WHERE session_id = ${call.sessionId})
      )
    `.pipe(Effect.asVoid, Effect.orDie);

  return { shownToTurn, throughSession, throughCall, record };
};
