// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoomId } from "@j3-bots/contracts";
import { IdempotencyKey } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { timeText } from "../persistence/columns.ts";
import type { WakesAfter } from "./Ledger.ts";
import { type Audience, sameAudience, type SessionRowId } from "./model.ts";

/** The engine key of one round of a Stop of one session. */
export const stopKey = (stopId: string, sessionId: string, round: number): IdempotencyKey =>
  IdempotencyKey.make(`${stopId}:${sessionId}:${round}`);

const StopScope = Schema.Struct({
  scope: Schema.Literals(["bot", "room"]),
  room_id: Schema.NullOr(RoomId),
});

/**
 * The bookkeeping of Stop targets the observer and the Stop runner share
 * (`docs/architecture/server.md`, Stop). It runs in the caller's transaction.
 */
export const stopTargets = (sql: SqlClient.SqlClient) => {
  const now = Effect.map(DateTime.now, timeText);

  const latestStop = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: StopScope,
    execute: (sessionId) => sql`
      SELECT s.scope, s.room_id FROM stops s
      JOIN stop_targets t ON t.stop_id = s.id
      WHERE t.session_id = ${sessionId}
      ORDER BY s.rowid DESC LIMIT 1
    `,
  });

  const fenceOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: StopScope,
    execute: (stopId) => sql`SELECT scope, room_id FROM stops WHERE id = ${stopId}`,
  });

  return {
    /**
     * Whether the Stop that fenced a dispatch stopped what it was for: every
     * one of a bot Stop, and a room Stop's own room. A room's Stop also fences
     * private work in a member's session, which the operator did not stop.
     */
    stoppedByFence: Effect.fn("stopTargets.stoppedByFence")(function* (dispatch: {
      readonly fenced_by_stop_id: string | null;
      readonly audience: "conversation" | "room";
      readonly audience_room_id: RoomId | null;
    }) {
      if (dispatch.fenced_by_stop_id === null) return false;
      const fence = yield* fenceOf(dispatch.fenced_by_stop_id).pipe(Effect.orDie);
      if (Option.isNone(fence) || fence.value.scope === "bot") return true;
      return dispatch.audience === "room" && dispatch.audience_room_id === fence.value.room_id;
    }),

    /**
     * Confirms every unsettled target of the session once the latest round of
     * each was observed (the events were synchronized past its acknowledgment)
     * and the events show nothing left running: no turn, no dispatch the engine
     * has not settled, no continuation pending. Whether one was confirmed.
     */
    confirm: Effect.fn("stopTargets.confirm")(function* (sessionId: SessionRowId) {
      const rows = yield* sql<{ readonly n: number }>`
        UPDATE stop_targets SET stopped_at = ${yield* now}
        WHERE session_id = ${sessionId} AND stopped_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets u
            WHERE u.session_id = ${sessionId} AND u.stopped_at IS NULL AND u.observed_at IS NULL
              AND u.round = (
                SELECT MAX(v.round) FROM stop_targets v
                WHERE v.stop_id = u.stop_id AND v.session_id = u.session_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM turns t WHERE t.session_id = ${sessionId} AND t.finished_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM dispatches d WHERE d.session_id = ${sessionId} AND (
              d.status = 'accepted'
              OR (d.status = 'intended' AND d.attempts > 0)
              OR (d.status = 'delivered' AND d.continuation_resumes_at IS NOT NULL)
            )
          )
        RETURNING 1 AS n
      `;
      return rows.length > 0;
    }, Effect.orDie),

    /**
     * A turn started in the session after a round of its Stop was issued (a
     * fenced dispatch the engine applied after all, a continuation, a run
     * that began between the Stop's commands): the round may have missed it,
     * so each target still unsettled gets a new round, not yet issued. A turn
     * delivering a dispatch the Stop fenced reopens that Stop's target even
     * once confirmed: the engine applied the key after the Stop ended
     * everything else. Whether one was opened.
     */
    openRound: Effect.fn("stopTargets.openRound")(function* (
      sessionId: SessionRowId,
      fencedBy: string | null,
    ) {
      const targets = yield* sql<{ readonly stop_id: string; readonly round: number }>`
        SELECT t.stop_id, t.round FROM stop_targets t
        WHERE t.session_id = ${sessionId}
          AND t.round = (
            SELECT MAX(u.round) FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id
          )
          AND (
            (t.stopped_at IS NULL AND t.issued_at IS NOT NULL)
            OR (t.stopped_at IS NOT NULL AND t.stop_id = ${fencedBy})
          )
      `;
      for (const target of targets) {
        const round = target.round + 1;
        yield* sql`
          INSERT INTO stop_targets (stop_id, session_id, round, engine_key)
          VALUES (${target.stop_id}, ${sessionId}, ${round}, ${stopKey(target.stop_id, sessionId, round)})
        `;
      }
      return targets.length > 0;
    }, Effect.orDie),

    /**
     * What becomes of the wakes of a dispatch a Stop ended in the engine:
     * cancelled when the operator stopped them (the bot, or the room they were
     * for), failed as `stopped` when a room's Stop reached them on their way to
     * the bot in private.
     */
    wakesAfterStop: Effect.fn("stopTargets.wakesAfterStop")(function* (
      sessionId: SessionRowId,
      audience: Audience,
    ) {
      const stop = yield* latestStop(sessionId).pipe(Effect.orDie);
      if (Option.isNone(stop) || stop.value.scope === "bot") {
        return { _tag: "cancelled" } satisfies WakesAfter;
      }
      return sameAudience(audience, { _tag: "room", roomId: stop.value.room_id })
        ? ({ _tag: "cancelled" } satisfies WakesAfter)
        : ({ _tag: "failed", reason: "stopped" } satisfies WakesAfter);
    }),

    /** Whether a Stop recorded since `since` reached the session in the dispatch's scope. */
    stoppedSince: Effect.fn("stopTargets.stoppedSince")(function* (
      sessionId: SessionRowId,
      since: DateTime.Utc,
      audience: Audience,
    ) {
      const rows = yield* sql<{ readonly scope: string; readonly room_id: string | null }>`
        SELECT DISTINCT s.scope, s.room_id FROM stops s
        JOIN stop_targets t ON t.stop_id = s.id
        WHERE t.session_id = ${sessionId} AND s.created_at >= ${timeText(since)}
      `.pipe(Effect.orDie);
      return rows.some(
        (row) =>
          row.scope === "bot" ||
          (audience._tag === "room" && audience.roomId !== null && audience.roomId === row.room_id),
      );
    }),
  };
};
