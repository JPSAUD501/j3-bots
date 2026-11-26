// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

/** Which opening: the `first-run` wake of a bot, or one opening wake by id. */
export type OpeningOf =
  | { readonly botId: Statement.Fragment | string }
  | { readonly wakeId: Statement.Fragment | string };

/**
 * Whether the opening is not yet with the engine: its `first-run` wake
 * pending, or written into a dispatch never sent. A send's claim needs that
 * dispatch still `intended` with no attempt, so a transaction that finds it so
 * can release it before the engine sees it.
 */
export const openingUnsentSql = (sql: SqlClient.SqlClient, of: OpeningOf) => sql`
  EXISTS (
    SELECT 1 FROM wakes ou_wake LEFT JOIN dispatches ou_dispatch
      ON ou_dispatch.id = ou_wake.dispatch_id
    WHERE ${
      "botId" in of
        ? sql`ou_wake.bot_id = ${of.botId}
            AND json_extract(ou_wake.payload_json, '$._tag') = 'first-run'`
        : sql`ou_wake.id = ${of.wakeId}`
    }
      AND (
        ou_wake.status = 'pending'
        OR (
          ou_wake.status = 'dispatched' AND ou_dispatch.status = 'intended'
          AND ou_dispatch.attempts = 0
        )
      )
  )
`;

/**
 * Whether the opening in the `wakes` row aliased `opening` has not ended: its
 * wake pending, its dispatch not yet delivered, or the turn that delivers it
 * still running. A `say` or `ask` that closes the turn finishes the wake while
 * the engine still runs that turn (`Ledger.closeDelivery`), so its dispatch
 * decides until the turn's end finishes or drops it, or a lost session
 * interrupts it. A turn that ended at a usage limit with a continuation
 * pending has ended too: the operator's messages go as one written then
 * would, and the engine drops the continuation (`docs/architecture/server.md`,
 * Continuations).
 */
export const openingOpenSql = (sql: SqlClient.SqlClient, opening: string) => sql`
  (
    ${sql.literal(opening)}.status = 'pending' OR EXISTS (
      SELECT 1 FROM dispatches oo_dispatch
      WHERE oo_dispatch.id = ${sql.literal(opening)}.dispatch_id
        AND (
          (${sql.literal(opening)}.status = 'dispatched'
            AND oo_dispatch.status IN ('intended', 'accepted'))
          OR (oo_dispatch.status = 'delivered' AND oo_dispatch.continuation_resumes_at IS NULL)
        )
    )
  )
`;

/**
 * Whether the wake in the `wakes` row aliased `wake` waits behind its bot's
 * opening (`behind_opening_id`) and that opening has not ended
 * (`openingOpenSql`). Once it has ended, the wake is ordinary work, in the
 * order it was written.
 */
export const behindOpeningSql = (sql: SqlClient.SqlClient, wake: string) => sql`
  (
    ${sql.literal(wake)}.behind_opening_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM wakes bo_opening
      WHERE bo_opening.id = ${sql.literal(wake)}.behind_opening_id
        AND ${openingOpenSql(sql, "bo_opening")}
    )
  )
`;
