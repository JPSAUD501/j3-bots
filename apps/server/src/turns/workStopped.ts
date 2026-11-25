// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { hopCounts } from "./hopCounts.ts";
import { type Audience, DispatchSeq, type SessionRowId } from "./model.ts";
import { stopTargets } from "./stopTargets.ts";

/** A turn whose work a Stop may cover: the bot's, in its session, for `audience`. */
export interface SpeakingTurn {
  readonly sessionId: SessionRowId;
  readonly botId: BotId;
  readonly turnId: TurnId;
  readonly audience: Audience;
}

/**
 * Whether a Stop covers a turn's work, in the caller's transaction, and the
 * dispatch that began that work (`seq`, `null` when none did): a Stop
 * recorded while a turn of its chain ran, or, of the bot or of the audience,
 * after the dispatch that began the chain's work was written. A turn the
 * engine started on its own goes on with the work of the turn it names
 * (`hopCounts`), so a Stop that covers that work covers it too, also one
 * recorded before it began; for work it does not name, only the first
 * counts.
 */
export const workStopped = (sql: SqlClient.SqlClient) => {
  const chains = hopCounts(sql);
  const stops = stopTargets(sql);
  return Effect.fn("workStopped")(function* (turn: SpeakingTurn) {
    const chain = chains.chainSql(turn.sessionId, turn.turnId);
    const [found] = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ stopped: Schema.BooleanFromBit, seq: Schema.NullOr(DispatchSeq) }),
      execute: () => sql`
        SELECT
          EXISTS (
            SELECT 1 FROM turns ws_turn
            WHERE ws_turn.session_id = ${turn.sessionId} AND ws_turn.stop_id IS NOT NULL
              AND ws_turn.engine_turn_id IN (${chain})
          ) AS stopped,
          (
            SELECT MIN(ws_dispatch.seq) FROM dispatches ws_dispatch
            WHERE ws_dispatch.session_id = ${turn.sessionId}
              AND ws_dispatch.engine_turn_id IN (${chain})
          ) AS seq
      `,
    })(undefined).pipe(Effect.orDie);
    if (found === undefined) return { stopped: false, seq: null };
    const stopped =
      found.stopped ||
      (found.seq !== null && (yield* stops.covers(turn.botId, turn.audience, found.seq)));
    return { stopped, seq: found.seq };
  });
};
