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
 * Whether the wake in the `wakes` row aliased `wake` waits behind its bot's
 * opening (`behind_opening_id`) and that opening has not ended: pending, or
 * dispatched and not yet finished, failed or cancelled. Once it has ended, the
 * wake is ordinary work, in the order it was written.
 */
export const behindOpeningSql = (sql: SqlClient.SqlClient, wake: string) => sql`
  (
    ${sql.literal(wake)}.behind_opening_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM wakes bo_opening
      WHERE bo_opening.id = ${sql.literal(wake)}.behind_opening_id
        AND bo_opening.status IN ('pending', 'dispatched')
    )
  )
`;
