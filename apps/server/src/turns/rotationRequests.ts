// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SessionRowId } from "./model.ts";
import type { Signals } from "./Signals.ts";

/**
 * Why a bot's main session is to be replaced (`docs/architecture/server.md`,
 * Rotation): it ran `ROTATE_AFTER_RUNS` turns, the engine could not resume the
 * provider's conversation, the bot moved to another provider, or the operator
 * asked for a fresh start.
 */
export const RotationReason = Schema.Literals([
  "runs",
  "context-recovered",
  "provider-changed",
  "fresh-start",
]);
export type RotationReason = typeof RotationReason.Type;

/**
 * Asks for a live main session to be replaced. Nothing new is planned into it
 * from then on; the rotator replaces it once it is idle. A session already
 * due for rotation keeps its first reason. Runs in the caller's transaction,
 * or in its own.
 */
export const rotationRequests = (sql: SqlClient.SqlClient, signals: Signals["Service"]) => {
  const requested = (rows: ReadonlyArray<unknown>) =>
    rows.length > 0 ? sql.afterCommit(signals.rotations.fire) : Effect.void;

  const requestRotation = Effect.fn("rotationRequests.ofSession")(function* (
    sessionId: SessionRowId,
    reason: RotationReason,
  ) {
    yield* requested(
      yield* sql`
        UPDATE sessions SET rotation_reason = ${reason}
        WHERE id = ${sessionId} AND purpose = 'main' AND retired_at IS NULL
          AND lost_at IS NULL AND rotation_reason IS NULL
        RETURNING id
      `,
    );
  }, Effect.orDie);

  const requestBotRotation = Effect.fn("rotationRequests.ofBot")(function* (
    botId: BotId,
    reason: RotationReason,
  ) {
    yield* requested(
      yield* sql`
        UPDATE sessions SET rotation_reason = ${reason}
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
          AND lost_at IS NULL AND rotation_reason IS NULL
        RETURNING id
      `,
    );
  }, Effect.orDie);

  return { requestRotation, requestBotRotation };
};
