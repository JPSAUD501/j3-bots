// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SessionRowId } from "./model.ts";

/**
 * Records `entryId` as the newest message the turn said in its bot's
 * conversation, in the caller's transaction, the one that publishes it: a
 * reply the AI suggests after the turn follows that message
 * (`SuggestedReplies`).
 */
export const saidInConversation = (
  sql: SqlClient.SqlClient,
  sessionId: SessionRowId,
  turnId: TurnId,
  entryId: EntryId,
) =>
  sql`
    UPDATE turns SET said_entry_id = ${entryId}
    WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
  `.pipe(Effect.orDie, Effect.asVoid);
