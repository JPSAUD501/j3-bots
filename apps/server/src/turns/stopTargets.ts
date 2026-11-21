// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId } from "@j3-bots/contracts";
import { IdempotencyKey } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import { Time, timeText } from "../persistence/columns.ts";
import type { WakesAfter } from "./Ledger.ts";
import {
  type Audience,
  audienceOf,
  type DispatchSeq,
  recoveryBackoff,
  type SessionRowId,
  stopGrace,
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

/**
 * Whether an unsettled Stop of the session holds a first send into it
 * (`docs/architecture/server.md`, Stop). Every one does, except that a steer
 * into the admitted turn passes a room's Stop for another room that has
 * issued no round there yet: that Stop sends nothing while a turn of another
 * audience runs (`Stops`), nor while the steer is unsettled. What the steer
 * adds ends with that turn, or becomes one turn of its own: a new turn
 * (`new-turn`) when that turn already ended in the engine, or a follow-up
 * (`steer-requeued`) when it ends without taking the steer. The Stop waits
 * for that turn in turn, unless the engine holds the queue, as after a failed
 * turn, where it cannot start: the Stop then cancels it. (A `new-turn` is
 * **Assumed** not to start while the engine holds the queue.) A wait on a
 * turn no event shows is bounded (`ROOM_ROUND_HOLD_BOUND`).
 * `steerRoom` is the steer's room column, NULL for the conversation, and
 * `null` for a send that is no steer. The planner, a send and its claim read
 * it with the same rule. `sessionId` is often a caller's column, so the tables
 * here have aliases no caller uses.
 */
export const stopHoldsSql = (
  sql: SqlClient.SqlClient,
  sessionId: Statement.Fragment,
  steerRoom: Statement.Fragment | null,
) => sql`EXISTS (
  SELECT 1 FROM stop_targets sh_target JOIN stops sh_stop ON sh_stop.id = sh_target.stop_id
  WHERE sh_target.session_id = ${sessionId} AND sh_target.stopped_at IS NULL
    ${
      steerRoom === null
        ? sql``
        : sql`AND NOT (
          sh_stop.room_id IS NOT NULL AND sh_stop.room_id IS NOT ${steerRoom}
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets sh_round
            WHERE sh_round.stop_id = sh_target.stop_id
              AND sh_round.session_id = sh_target.session_id AND sh_round.issued_at IS NOT NULL
          )
        )`
    }
)`;

/** The engine key of one round of a Stop of one session. */
export const stopKey = (stopId: string, sessionId: string, round: number): IdempotencyKey =>
  IdempotencyKey.make(`${stopId}:${sessionId}:${round}`);

/**
 * The bookkeeping of Stop targets the observer and the Stop runner share
 * (`docs/architecture/server.md`, Stop). It runs in the caller's transaction.
 *
 * The rule it keeps: a target settles only when the engine's own state shows
 * nothing the Stop targeted can still run, no run waiting, preparing,
 * starting or running and no background work pending; and while a target is
 * unsettled, something keeps acting on it. Its latest round is always in a
 * state that a durable deadline or an event moves on, so nothing waits on its
 * own:
 *
 * - not sent: the runner sends it once due (`due_at`), and resolves a send
 *   whose answer was lost by the round's key;
 * - refused: a fresh round follows, due after a backoff (`rejectRound`);
 * - acknowledged, or found moot: the runner synchronizes the session until
 *   the target settles, and once the round's grace passed (`recheck_at`)
 *   with the engine still showing targeted work, a fresh round follows
 *   (`recheck`);
 * - missed: a turn that starts after the round was issued opens a fresh round
 *   at once (`openRound`).
 *
 * A session the engine no longer has settles its targets, since nothing runs
 * there, and no round follows one of them: a fresh round is opened only for a
 * target still unsettled in a session not lost, checked in the transaction
 * that opens it, so an answer the runner heard before the loss committed
 * reopens nothing.
 */
export const stopTargets = (sql: SqlClient.SqlClient) => {
  const now = Effect.map(DateTime.now, timeText);

  /**
   * What the session's applied events show the Stop still has to end: a turn
   * running, a dispatch the engine queued or may still be taking, a
   * continuation it will start on its own.
   */
  const workShows = (sessionId: SessionRowId) => sql`(
    EXISTS (SELECT 1 FROM turns t WHERE t.session_id = ${sessionId} AND t.finished_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM dispatches d WHERE d.session_id = ${sessionId} AND (
        d.status = 'accepted'
        OR (d.status = 'intended' AND d.attempts > 0)
        OR (d.status = 'delivered' AND d.continuation_resumes_at IS NOT NULL)
      )
    )
  )`;

  /** The earliest grace of a latest round still running in the session. */
  const nextRecheck = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, at: Schema.String }),
    Result: Schema.Struct({ at: Schema.NullOr(Time) }),
    execute: ({ sessionId, at }) => sql`
      SELECT MIN(t.recheck_at) AS at FROM stop_targets t
      WHERE t.session_id = ${sessionId} AND t.stopped_at IS NULL AND t.recheck_at > ${at}
        AND NOT EXISTS (
          SELECT 1 FROM stop_targets u
          WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id AND u.round > t.round
        )
    `,
  });

  /**
   * A fresh round after `round`, unless one followed it already (at most one
   * does), or its target settled meanwhile, also by the loss of its session.
   */
  const followRound = Effect.fn("stopTargets.followRound")(function* (
    round: { readonly stop_id: string; readonly session_id: SessionRowId; readonly round: number },
    dueAt: DateTime.Utc | null,
  ) {
    const next = round.round + 1;
    const opened = yield* sql<{ readonly n: number }>`
      INSERT INTO stop_targets (stop_id, session_id, round, engine_key, due_at)
      SELECT ${round.stop_id}, ${round.session_id}, ${next},
        ${stopKey(round.stop_id, round.session_id, next)},
        ${dueAt === null ? null : timeText(dueAt)}
      WHERE NOT EXISTS (
        SELECT 1 FROM stop_targets
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round > ${round.round}
      ) AND EXISTS (
        SELECT 1 FROM stop_targets p JOIN sessions s ON s.id = p.session_id
        WHERE p.stop_id = ${round.stop_id} AND p.session_id = ${round.session_id}
          AND p.round = ${round.round} AND p.stopped_at IS NULL AND s.lost_at IS NULL
      )
      RETURNING 1 AS n
    `;
    return opened.length > 0;
  });

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
          AND NOT ${workShows(sessionId)}
        RETURNING 1 AS n
      `;
      return rows.length > 0;
    }, Effect.orDie),

    /**
     * The engine acknowledged the round's commands, or found them moot. It
     * gets a grace that grows with each round of the target it acknowledged
     * (`stopGrace`), after which `recheck` follows it with a fresh round
     * while the engine still shows work the Stop targets.
     */
    acknowledge: Effect.fn("stopTargets.acknowledge")(function* (round: {
      readonly stop_id: string;
      readonly session_id: SessionRowId;
      readonly round: number;
    }) {
      const at = yield* DateTime.now;
      const [acknowledged] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM stop_targets
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND sent_at IS NOT NULL
      `;
      const recheckAt = DateTime.addDuration(at, stopGrace((acknowledged?.n ?? 0) + 1));
      yield* sql`
        UPDATE stop_targets SET sent_at = ${timeText(at)}, recheck_at = ${timeText(recheckAt)}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie),

    /**
     * After the session's events were synchronized: each unsettled target
     * whose latest round the engine acknowledged, and whose grace passed while
     * the engine still shows work the Stop targets, gets a fresh round, due at
     * once. `engineShows` is what the marker showed beyond the applied events:
     * background work pending, or a run the engine can still run, also one no
     * event told of. This covers what no event announces: an interrupt the
     * engine could not carry out after it acknowledged the stop, a run whose
     * provider never starts, a run the engine queued on its own after the
     * round's cancels.
     * Whether one was opened, and the earliest grace still running, for the
     * runner to look again then.
     */
    recheck: Effect.fn("stopTargets.recheck")(function* (
      sessionId: SessionRowId,
      engineShows: boolean,
    ) {
      const at = yield* now;
      const due = yield* sql<{ readonly stop_id: string; readonly round: number }>`
        SELECT t.stop_id, t.round FROM stop_targets t
        WHERE t.session_id = ${sessionId} AND t.stopped_at IS NULL
          AND t.recheck_at <= ${at}
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id AND u.round > t.round
          )
          AND (${engineShows ? sql`1` : sql`0`} OR ${workShows(sessionId)})
      `;
      let opened = false;
      for (const round of due) {
        if (yield* followRound({ ...round, session_id: sessionId }, null)) opened = true;
      }
      const [waiting] = yield* nextRecheck({ sessionId, at });
      return { opened, next: waiting?.at ?? null };
    }, Effect.orDie),

    /**
     * A turn started in the session after a round of its Stop was issued (a
     * fenced dispatch the engine applied after all, a continuation, a run
     * that began between the Stop's commands): the round may have missed it,
     * so each target still unsettled gets a new round, not yet issued. A turn
     * delivering a dispatch the Stop fenced reopens that Stop's target even
     * once confirmed: the engine applied the key after the Stop ended
     * everything else, also a key whose recovery gave up (`unresolved`).
     * A lost session's targets stay settled. Whether one was opened.
     */
    openRound: Effect.fn("stopTargets.openRound")(function* (
      sessionId: SessionRowId,
      fencedBy: string | null,
    ) {
      const targets = yield* sql<{ readonly stop_id: string; readonly round: number }>`
        SELECT t.stop_id, t.round FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        WHERE t.session_id = ${sessionId} AND s.lost_at IS NULL
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
     * refused, and the target gets a fresh round, due once the backoff of the
     * rounds refused since the engine last acknowledged one passes. A newer
     * round, opened meanwhile by a turn that started, goes out on its own
     * instead; a target that settled meanwhile, as when its session was lost
     * after the engine refused, gets none.
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
        SELECT COUNT(*) AS n FROM stop_targets t
        WHERE t.stop_id = ${round.stop_id} AND t.session_id = ${round.session_id}
          AND t.rejected_at IS NOT NULL
          AND t.round > COALESCE((
            SELECT MAX(u.round) FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id AND u.sent_at IS NOT NULL
          ), -1)
      `;
      yield* followRound(round, DateTime.addDuration(at, recoveryBackoff(refused?.n ?? 1)));
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
    ): Effect.fn.Return<WakesAfter> {
      if (yield* covers(dispatch.bot_id, audienceOf(dispatch), dispatch.seq)) {
        return { _tag: "cancelled" };
      }
      switch (ending._tag) {
        case "unsent":
          return { _tag: "pending" };
        case "dropped":
          return { _tag: "failed", reason: "stopped" };
        case "failed":
          return { _tag: "failed", reason: ending.reason };
      }
    }),
  };
};
