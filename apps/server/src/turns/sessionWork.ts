// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoomId } from "@j3-bots/contracts";
import { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { type Audience, AudienceColumn, audienceOf } from "./model.ts";
import { stopHoldsSql } from "./stopTargets.ts";

const WorkRow = Schema.Struct({
  admitted_turn_id: Schema.NullOr(TurnId),
  admitted_audience: Schema.NullOr(AudienceColumn),
  admitted_room_id: Schema.NullOr(RoomId),
  running_turns: Schema.Int,
  unsent: Schema.Int,
  in_engine: Schema.Int,
  continuations: Schema.Int,
  stop_unsettled: Schema.BooleanFromBit,
  stop_holds_steers: Schema.BooleanFromBit,
});

/** What a session is doing, as far as the server knows: what readiness, Stop and the roster read. */
export interface SessionWork {
  /** Its running turn, once the provider took it, and where that turn's speech goes. */
  readonly admitted: { readonly turnId: TurnId; readonly audience: Audience } | null;
  /** Turns the events showed starting and not yet finishing. */
  readonly runningTurns: number;
  /** Dispatches written and not yet answered, sent or not. */
  readonly unsent: number;
  /** Dispatches the engine has, not yet finished, with no continuation pending. */
  readonly inEngine: number;
  /** Dispatches delivered whose turn the engine will continue at a usage limit's reset. */
  readonly continuations: number;
  /** A Stop of the session has a target not yet confirmed stopped. */
  readonly stopUnsettled: boolean;
  /**
   * Such a Stop also holds the operator's steer into the admitted turn: one
   * not a room's Stop for another room still waiting to send its first round
   * (`stopHoldsSql`).
   */
  readonly stopHoldsSteers: boolean;
}

/** Nothing is running in it or on its way to it; a pending continuation may still be. */
export const isIdle = (work: SessionWork): boolean =>
  work.admitted === null && work.runningTurns === 0 && work.unsent === 0 && work.inEngine === 0;

export const sessionWork = (sql: SqlClient.SqlClient) => {
  const query = SqlSchema.findOne({
    Request: Schema.String,
    Result: WorkRow,
    execute: (sessionId) => sql`
      SELECT s.admitted_turn_id, s.admitted_audience, s.admitted_room_id,
        (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.finished_at IS NULL)
          AS running_turns,
        (SELECT COUNT(*) FROM dispatches d WHERE d.session_id = s.id AND d.status = 'intended')
          AS unsent,
        (SELECT COUNT(*) FROM dispatches d WHERE d.session_id = s.id
          AND (d.status = 'accepted'
            OR (d.status = 'delivered' AND d.continuation_resumes_at IS NULL))) AS in_engine,
        (SELECT COUNT(*) FROM dispatches d WHERE d.session_id = s.id
          AND d.status = 'delivered' AND d.continuation_resumes_at IS NOT NULL) AS continuations,
        EXISTS (
          SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
        ) AS stop_unsettled,
        ${stopHoldsSql(sql, sql`s.id`, sql`s.admitted_room_id`)} AS stop_holds_steers
      FROM sessions s WHERE s.id = ${sessionId}
    `,
  });
  return (sessionId: string): Effect.Effect<SessionWork> =>
    query(sessionId).pipe(
      Effect.orDie,
      Effect.map((row) => ({
        admitted:
          row.admitted_turn_id === null || row.admitted_audience === null
            ? null
            : {
                turnId: row.admitted_turn_id,
                audience: audienceOf({
                  audience: row.admitted_audience,
                  audience_room_id: row.admitted_room_id,
                }),
              },
        runningTurns: row.running_turns,
        unsent: row.unsent,
        inEngine: row.in_engine,
        continuations: row.continuations,
        stopUnsettled: row.stop_unsettled,
        stopHoldsSteers: row.stop_holds_steers,
      })),
    );
};
