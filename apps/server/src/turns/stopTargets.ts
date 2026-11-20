// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId } from "@j3-bots/contracts";
import { IdempotencyKey } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { timeText } from "../persistence/columns.ts";
import type { WakesAfter } from "./Ledger.ts";
import {
  type Audience,
  audienceOf,
  type DispatchSeq,
  recoveryBackoff,
  type SessionRowId,
  type WakeFailure,
} from "./model.ts";

/** How a dispatch's work ended short of running to its end. */
export type Ending =
  /** The engine certainly never had it. */
  | { readonly _tag: "unsent" }
  /** The engine dropped the turn it was to start or ride. */
  | { readonly _tag: "dropped" }
  /** It failed: refused, or never known. */
  | { readonly _tag: "failed"; readonly reason: WakeFailure };

/** The engine key of one round of a Stop of one session. */
export const stopKey = (stopId: string, sessionId: string, round: number): IdempotencyKey =>
  IdempotencyKey.make(`${stopId}:${sessionId}:${round}`);

/**
 * The bookkeeping of Stop targets the observer and the Stop runner share
 * (`docs/architecture/server.md`, Stop). It runs in the caller's transaction.
 */
export const stopTargets = (sql: SqlClient.SqlClient) => {
  const now = Effect.map(DateTime.now, timeText);

  /**
   * Whether a Stop of the bot covers work for `audience` that began with the
   * dispatch written at `seq`: a bot Stop, or a room Stop of that room,
   * recorded once that dispatch was written (its mark is at or above `seq`),
   * which so ended that work after it began. Such work wakes nobody and needs
   * no notice. Work whose dispatch was written after a Stop is new intent,
   * whatever became of that Stop's targets.
   */
  const covers = Effect.fn("stopTargets.covers")(function* (
    botId: BotId,
    audience: Audience,
    seq: DispatchSeq,
  ) {
    const roomId = audience._tag === "room" ? audience.roomId : null;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT 1 AS n FROM stops s
      WHERE s.bot_id = ${botId}
        AND (s.scope = 'bot' OR (s.scope = 'room' AND s.room_id = ${roomId}))
        AND s.dispatch_mark >= ${seq}
      LIMIT 1
    `.pipe(Effect.orDie);
    return rows.length > 0;
  });

  return {
    covers,

    /**
     * Confirms every unsettled target of the session once the latest round of
     * each was observed (the events were synchronized past its acknowledgment,
     * with no background work pending at the marker) and the events show
     * nothing left running: no turn, no dispatch the engine has not settled,
     * no continuation pending. Whether one was confirmed.
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
     * everything else, also a key whose recovery gave up (`unresolved`).
     * Whether one was opened.
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
     * The engine refused a round while what the Stop targets can still run,
     * which spends the round's key (`StopRejected`): the round is marked
     * refused, and the target gets a fresh round, sent once the backoff of
     * its refused rounds passes. A newer round, opened meanwhile by a turn
     * that started, goes out on its own instead.
     */
    rejectRound: Effect.fn("stopTargets.rejectRound")(function* (round: {
      readonly stop_id: string;
      readonly session_id: SessionRowId;
      readonly round: number;
    }) {
      const at = yield* DateTime.now;
      yield* sql`
        UPDATE stop_targets SET rejected_at = ${timeText(at)}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
      const [refused] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND rejected_at IS NOT NULL
      `;
      const retryAt = DateTime.addDuration(at, recoveryBackoff(refused?.n ?? 1));
      const next = round.round + 1;
      yield* sql`
        INSERT INTO stop_targets (stop_id, session_id, round, engine_key, retry_at)
        SELECT ${round.stop_id}, ${round.session_id}, ${next},
          ${stopKey(round.stop_id, round.session_id, next)}, ${timeText(retryAt)}
        WHERE NOT EXISTS (
          SELECT 1 FROM stop_targets
          WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
            AND round > ${round.round}
        )
      `;
    }, Effect.orDie),

    /**
     * What becomes of the wakes of a dispatch that will not run to its end,
     * from the one Stop predicate (`covers`), read in the settlement's own
     * transaction: when a Stop covers the work, the operator stopped it and
     * its wakes are cancelled. Otherwise wakes the engine never had wait
     * again, wakes whose turn the engine dropped (a room's Stop reached the
     * bot's private work) fail as `stopped`, and any others fail with their
     * own reason.
     */
    wakesAfter: Effect.fn("stopTargets.wakesAfter")(function* (
      dispatch: {
        readonly bot_id: BotId;
        readonly audience: "conversation" | "room";
        readonly audience_room_id: RoomId | null;
        readonly seq: DispatchSeq;
      },
      ending: Ending,
    ) {
      if (yield* covers(dispatch.bot_id, audienceOf(dispatch), dispatch.seq)) {
        return { _tag: "cancelled" } satisfies WakesAfter as WakesAfter;
      }
      switch (ending._tag) {
        case "unsent":
          return { _tag: "pending" } satisfies WakesAfter as WakesAfter;
        case "dropped":
          return { _tag: "failed", reason: "stopped" } satisfies WakesAfter as WakesAfter;
        case "failed":
          return { _tag: "failed", reason: ending.reason } satisfies WakesAfter as WakesAfter;
      }
    }),
  };
};
