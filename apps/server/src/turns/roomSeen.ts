// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { SessionRowId } from "./model.ts";

const Through = Schema.Struct({ through: Schema.NullOr(Schema.Int) });

/** A tool call of a session, as the engine recorded it. */
export interface SessionCall {
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
  readonly callId: string;
}

/**
 * How far a session has seen a bot's rooms, and where a read or a refusal
 * records what it showed (`docs/architecture/server.md`, What a bot has seen
 * of a room). A session has seen a room through a place when it was shown the
 * room's newest entries up to it, or, by an envelope or a refused post, told
 * how many it was not shown: both leave out the oldest they cannot carry, and
 * count them. Each session has its own view: what one was shown never
 * reached another, a session that replaced it included.
 */
export const roomSeen = (sql: SqlClient.SqlClient) => {
  /**
   * What the session will have been shown of the room once the engine applies
   * the envelopes written for it so far, which its next room envelope leaves
   * out: the newest place any room dispatch to it was written after, among
   * those the engine may have applied, and any read or refusal of its calls
   * showed. A dispatch it certainly never applied (released, refused,
   * dropped) leaves its entries unseen, for the next envelope.
   */
  const seenBySession = SqlSchema.findOne({
    Request: Schema.Struct({ sessionId: Schema.String, roomId: Schema.String }),
    Result: Through,
    execute: ({ sessionId, roomId }) => sql`
      SELECT MAX(through) AS through FROM (
        SELECT room_through AS through FROM dispatches
        WHERE audience_room_id = ${roomId} AND session_id = ${sessionId}
          AND room_through IS NOT NULL
          AND status NOT IN ('released', 'dropped')
          AND NOT (status = 'failed' AND failure_reason = 'rejected')
        UNION ALL
        SELECT through FROM room_views WHERE room_id = ${roomId} AND session_id = ${sessionId}
      )
    `,
  });

  /**
   * What the call's session had been shown of the room when the bot wrote the
   * call: the room envelopes the engine took into the session, and the reads
   * and refusals of the session recorded before the engine recorded the call.
   * A call written beside a read, in the same model message, was written
   * without what the read showed.
   */
  const seenByCall = SqlSchema.findOne({
    Request: Schema.Struct({
      sessionId: Schema.String,
      callId: Schema.String,
      roomId: Schema.String,
    }),
    Result: Through,
    execute: ({ sessionId, callId, roomId }) => sql`
      SELECT MAX(through) AS through FROM (
        SELECT room_through AS through FROM dispatches
        WHERE audience_room_id = ${roomId} AND session_id = ${sessionId}
          AND room_through IS NOT NULL AND status IN ('delivered', 'finished')
        UNION ALL
        SELECT through FROM room_views
        WHERE room_id = ${roomId} AND session_id = ${sessionId}
          AND calls_known < (
            SELECT rowid FROM engine_tool_calls
            WHERE session_id = ${sessionId} AND engine_call_id = ${callId}
          )
      )
    `,
  });

  /** The place through which the session will have seen the room, or `null` for none of it. */
  const throughSession = (sessionId: SessionRowId, roomId: RoomId) =>
    seenBySession({ sessionId, roomId }).pipe(
      Effect.map((row) => row.through),
      Effect.orDie,
    );

  /** The place through which the call's session had seen the room when the call was written, or `null`. */
  const throughCall = (call: SessionCall, roomId: RoomId) =>
    seenByCall({ sessionId: call.sessionId, callId: call.callId, roomId }).pipe(
      Effect.map((row) => row.through),
      Effect.orDie,
    );

  /**
   * Records that the call was shown the room through `through`. The session's
   * calls the engine recorded by now were written before this view, so it
   * counts only for later ones.
   */
  const record = (call: SessionCall, roomId: RoomId, through: number) =>
    sql`
      INSERT INTO room_views (
        session_id, engine_call_id, engine_turn_id, room_id, through, calls_known
      ) VALUES (
        ${call.sessionId}, ${call.callId}, ${call.turnId}, ${roomId}, ${through},
        (SELECT COALESCE(MAX(rowid), 0) FROM engine_tool_calls WHERE session_id = ${call.sessionId})
      )
    `.pipe(Effect.asVoid, Effect.orDie);

  return { throughSession, throughCall, record };
};
