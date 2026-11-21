// SPDX-License-Identifier: AGPL-3.0-or-later
import { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { SessionRowId } from "./model.ts";

/** What a turn's chain carries that budgets count (`carriedIn`). */
const Carried = Schema.Struct({
  operator: Schema.BooleanFromBit,
  furthest: Schema.Int,
  rooted: Schema.BooleanFromBit,
});
type Carried = typeof Carried.Type;

/**
 * How a turn's chain counts its hops (`docs/architecture/server.md`,
 * Budgets), shared by the observer, which captures a harness's wake's count
 * when it admits the turn, and by speech, which counts each wake a turn
 * causes. It runs in the caller's transaction, if any.
 */
export const hopCounts = (sql: SqlClient.SqlClient) => {
  /**
   * The turn and the turns whose work it goes on with, as a subquery of
   * engine turn ids: the turn a continuation resumes, and the turn whose
   * background work woke the session when the engine names it
   * (`turns.origin_turn_id`). They count as one turn for budgets and Stops.
   */
  const chainSql = (sessionId: SessionRowId, turnId: TurnId) => sql`
    WITH RECURSIVE sp_chain (turn_id) AS (
      SELECT ${turnId}
      UNION
      SELECT sp_link.origin_turn_id FROM turns sp_link
      JOIN sp_chain ON sp_link.engine_turn_id = sp_chain.turn_id
      WHERE sp_link.session_id = ${sessionId} AND sp_link.origin_turn_id IS NOT NULL
    )
    SELECT turn_id FROM sp_chain
  `;

  /** The dispatches the turn's chain delivered, as a subquery. */
  const deliveredInSql = (sessionId: SessionRowId, turnId: TurnId) => sql`
    SELECT sp_dispatch.id FROM dispatches sp_dispatch
    WHERE sp_dispatch.session_id = ${sessionId}
      AND sp_dispatch.engine_turn_id IN (${chainSql(sessionId, turnId)})
      AND sp_dispatch.status IN ('accepted', 'delivered', 'finished')
  `;

  /**
   * What a turn's chain carries that budgets count: whether the operator's
   * word, as a wake or a steer the engine accepted, the furthest hop count
   * of the wakes and held messages it delivers, and whether any dispatch
   * began it at all (`rooted`): a turn the engine started on its own for
   * work it does not name has none.
   */
  const carriedIn = (sessionId: SessionRowId, turnId: TurnId) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Carried,
      execute: () => sql`
        WITH carried AS (
          SELECT cw.kind, cw.hops, cw.source_entry_id FROM wakes cw
          WHERE cw.dispatch_id IN (${deliveredInSql(sessionId, turnId)})
        )
        SELECT
          EXISTS (
            SELECT 1 FROM carried c
            WHERE c.kind = 'user' OR EXISTS (
              SELECT 1 FROM entries e
              WHERE e.id = c.source_entry_id AND e.author_kind = 'operator'
            )
          ) AS operator,
          MAX(
            COALESCE((SELECT MAX(hops) FROM carried), 0),
            COALESCE((
              SELECT MAX(hm.hops) FROM held_messages hm
              WHERE hm.consumed_dispatch_id IN (${deliveredInSql(sessionId, turnId)})
            ), 0)
          ) AS furthest,
          EXISTS (${deliveredInSql(sessionId, turnId)}) AS rooted
      `,
    })(undefined).pipe(
      Effect.orDie,
      Effect.map(([row]) => row ?? { operator: false, furthest: 0, rooted: false }),
    );

  /**
   * The hop count of a wake a chain causes: 1 when it carries the operator's
   * word, as a wake or a steer, so the chain starts again whenever they
   * speak; otherwise one more than the furthest wake or held message it
   * delivers.
   */
  const hopsOf = (carried: Carried) => (carried.operator ? 1 : carried.furthest + 1);

  /** The count a turn of the chain borrowed (`borrow`), if any did. */
  const borrowedIn = (sessionId: SessionRowId, turnId: TurnId) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ hops: Schema.NullOr(Schema.Int) }),
      execute: () => sql`
        SELECT MAX(hb_turn.borrowed_hops) AS hops FROM turns hb_turn
        WHERE hb_turn.session_id = ${sessionId}
          AND hb_turn.engine_turn_id IN (${chainSql(sessionId, turnId)})
      `,
    })(undefined).pipe(
      Effect.orDie,
      Effect.map(([row]) => row?.hops ?? null),
    );

  /**
   * The hop count of a wake the turn's chain causes as it stands: from what
   * it carries when a dispatch began it, from the count it borrowed when
   * none did, or `null` when it borrowed none.
   */
  const ownCount = Effect.fn("hopCounts.ownCount")(function* (
    sessionId: SessionRowId,
    turnId: TurnId,
  ) {
    const carried = yield* carriedIn(sessionId, turnId);
    if (carried.rooted) return hopsOf(carried);
    return yield* borrowedIn(sessionId, turnId);
  });

  /**
   * A turn the engine started on its own for work it does not name (a
   * harness's wake) never counts as the operator's: it counts as the
   * furthest of the session's other turns whose background work the engine
   * last showed pending (`turns.background_pending`), any of which may be
   * what woke it. A flag may outlive its work until the engine's next
   * report, so the count can come out higher than the work's own, never
   * lower. The turn keeps that count on its own row (`turns.borrowed_hops`),
   * so the turns that go on with its work count from it once those flags
   * have cleared. Taken when the turn is admitted, and again at a hop check
   * while it has none; with no such turn it cannot be traced (`null`).
   */
  const borrow = Effect.fn("hopCounts.borrow")(function* (sessionId: SessionRowId, turnId: TurnId) {
    const kept = yield* borrowedIn(sessionId, turnId);
    if (kept !== null) return kept;
    const candidates = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ engine_turn_id: TurnId }),
      execute: () => sql`
        SELECT hc_turn.engine_turn_id FROM turns hc_turn
        WHERE hc_turn.session_id = ${sessionId} AND hc_turn.background_pending = 1
          AND hc_turn.engine_turn_id NOT IN (${chainSql(sessionId, turnId)})
      `,
    })(undefined).pipe(Effect.orDie);
    let count: number | null = null;
    for (const candidate of candidates) {
      const theirs = yield* ownCount(sessionId, candidate.engine_turn_id);
      if (theirs !== null) count = Math.max(count ?? 0, theirs);
    }
    if (count !== null) {
      yield* sql`
        UPDATE turns SET borrowed_hops = ${count}
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
      `.pipe(Effect.orDie);
    }
    return count;
  });

  /** The hop count of a wake the turn causes, or `null` when it cannot be traced. */
  const hopCount = Effect.fn("hopCounts.hopCount")(function* (
    sessionId: SessionRowId,
    turnId: TurnId,
  ) {
    const carried = yield* carriedIn(sessionId, turnId);
    if (carried.rooted) return hopsOf(carried);
    return yield* borrow(sessionId, turnId);
  });

  return { chainSql, deliveredInSql, carriedIn, borrow, hopCount };
};
