// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SessionRowId } from "./model.ts";

/**
 * A quiet turn (`docs/architecture/server.md`, Reactions): one a reaction
 * alone started. Until it says, asks or reacts, it shows no work and tells
 * nothing of how it ended, so one that ends without a word leaves no trace.
 */
export const quietTurns = (sql: SqlClient.SqlClient) => ({
  /** The turn spoke: from now on it shows its work and its end as any turn does. */
  spoke: (sessionId: SessionRowId, turnId: TurnId) =>
    sql`
      UPDATE turns SET quiet = 0
      WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId} AND quiet = 1
    `.pipe(Effect.orDie, Effect.asVoid),
  /** Whether the turn is quiet still. */
  isQuiet: (sessionId: SessionRowId, turnId: TurnId) =>
    sql<{ readonly quiet: number }>`
      SELECT quiet FROM turns WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
    `.pipe(
      Effect.orDie,
      Effect.map(([turn]) => turn?.quiet === 1),
    ),
});
