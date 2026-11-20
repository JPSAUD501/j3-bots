// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Settings } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { SessionRowId } from "./model.ts";

/**
 * The turn budget's one admission rule, which the dispatcher plans with and a
 * first start's claim checks again in its own transaction: what was read
 * while its files staged may have changed since.
 */
export const admission = (
  sql: SqlClient.SqlClient,
  settings: { readonly get: Effect.Effect<Settings> },
) => {
  /**
   * Sessions with work the engine may have, across every bot: what the
   * budget counts. A turn the events show, or a dispatch sent at least once
   * and not settled (a delivered one whose continuation is pending included).
   * A dispatch never sent holds no slot, also while its files wait to be
   * staged again; it takes one when it is sent.
   */
  const busySessions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ id: SessionRowId }),
    execute: () => sql`
      SELECT s.id FROM sessions s
      WHERE s.retired_at IS NULL AND s.lost_at IS NULL AND (
        s.admitted_turn_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.finished_at IS NULL)
        OR EXISTS (
          SELECT 1 FROM dispatches d WHERE d.session_id = s.id
            AND (d.status IN ('accepted', 'delivered') OR (d.status = 'intended' AND d.attempts > 0))
        )
      )
    `,
  })(undefined).pipe(Effect.orDie);

  /**
   * Whether a start may be sent into the session now, by the one rule every
   * start follows, fresh or sent again after its files failed to stage: a
   * slot is free, or the session already holds one, as when its turn's
   * continuation is pending.
   */
  const admitsStart = Effect.fn("admission.admitsStart")(function* (sessionId: SessionRowId) {
    const { budgets } = yield* settings.get;
    const busy = yield* busySessions;
    return busy.length < budgets.concurrentTurns || busy.some((row) => row.id === sessionId);
  });

  return { admitsStart };
};
