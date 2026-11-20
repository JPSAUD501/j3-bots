// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SessionRowId } from "./model.ts";
import type { Signals } from "./Signals.ts";

/**
 * Why a bot's main session is to be replaced (`docs/architecture/server.md`,
 * Rotation), weakest first: it ran `ROTATE_AFTER_RUNS` turns, the engine could
 * not resume the provider's conversation, the operator moved the bot to
 * another provider, or the operator asked for a fresh start.
 */
export const RotationReason = Schema.Literals([
  "runs",
  "context-recovered",
  "provider-changed",
  "fresh-start",
]);
export type RotationReason = typeof RotationReason.Type;

/** A stronger reason replaces a weaker one; a fresh start replaces any. */
const STRENGTH: { readonly [R in RotationReason]: number } = {
  runs: 0,
  "context-recovered": 1,
  "provider-changed": 2,
  "fresh-start": 3,
};

/**
 * Whether a `sessions` row still takes new work: what the dispatcher plans
 * into, and checks again where it writes. Only the run limit leaves a session
 * planned into until it is quiet, so long background work never holds the
 * bot's wakes; any other reason holds new work for the session that replaces
 * it.
 */
export const takesNewWorkSql = (sql: SqlClient.SqlClient) =>
  sql`(rotation_reason IS NULL OR rotation_reason = 'runs')`;

/**
 * Asks for a bot's live main session, lost or not, to be replaced: the rotator
 * replaces it as its reason says. A session already due keeps its reason
 * unless the new one is stronger. Runs in the caller's transaction, or in its
 * own.
 */
export const rotationRequests = (sql: SqlClient.SqlClient, signals: Signals["Service"]) => {
  const requested = (rows: ReadonlyArray<unknown>) =>
    rows.length > 0 ? sql.afterCommit(signals.rotations.fire) : Effect.void;

  /** The reason's strength, and whether the session's current one is weaker. */
  const weaker = (reason: RotationReason) => sql`
    (rotation_reason IS NULL OR CASE rotation_reason
      WHEN 'runs' THEN ${STRENGTH.runs}
      WHEN 'context-recovered' THEN ${STRENGTH["context-recovered"]}
      WHEN 'provider-changed' THEN ${STRENGTH["provider-changed"]}
      WHEN 'fresh-start' THEN ${STRENGTH["fresh-start"]}
    END < ${STRENGTH[reason]})
  `;

  const requestRotation = Effect.fn("rotationRequests.ofSession")(function* (
    sessionId: SessionRowId,
    reason: RotationReason,
  ) {
    yield* requested(
      yield* sql`
        UPDATE sessions SET rotation_reason = ${reason}
        WHERE id = ${sessionId} AND purpose = 'main' AND retired_at IS NULL AND ${weaker(reason)}
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
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL AND ${weaker(reason)}
        RETURNING id
      `,
    );
  }, Effect.orDie);

  /**
   * Drops the digests no envelope carried yet: a later rotation writes its
   * own, which supersedes them, and a fresh start carries none.
   */
  const dropDigests = Effect.fn("rotationRequests.dropDigests")(function* (botId: BotId) {
    yield* sql`
      DELETE FROM catch_up_notes
      WHERE bot_id = ${botId} AND consumed_dispatch_id IS NULL
        AND json_extract(note_json, '$._tag') = 'session-rotated'
    `;
  }, Effect.orDie);

  return { requestRotation, requestBotRotation, dropDigests };
};
