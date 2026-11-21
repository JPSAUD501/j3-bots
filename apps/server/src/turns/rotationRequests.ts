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
 * Whether a `catch_up_notes` row reports a conversation entry from before its
 * bot's latest fresh start, which nothing reaches the bot's working context
 * from (`forgetConversation`).
 */
export const fromBeforeFreshStartSql = (sql: SqlClient.SqlClient) => sql`(
  catch_up_notes.source_position < (
    SELECT fs_conversation.digest_from_position FROM conversations fs_conversation
    WHERE fs_conversation.bot_id = catch_up_notes.bot_id
  )
)`;

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
   * The operator moved the bot back to the provider its live main session
   * runs on before the session was replaced: it is no longer due for that,
   * and takes the wakes held for its replacement. A weaker reason the move
   * overrode is not restored; the run limit is asked for again by the
   * rotator's next pass.
   */
  const providerRestored = Effect.fn("rotationRequests.providerRestored")(function* (botId: BotId) {
    const restored = yield* sql`
      UPDATE sessions SET rotation_reason = NULL
      WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
        AND rotation_reason = 'provider-changed'
      RETURNING id
    `;
    if (restored.length > 0) yield* sql.afterCommit(signals.dispatch.fire);
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

  /**
   * A fresh start: the digests no envelope carried yet are dropped, and no
   * later digest reaches back past what the conversation holds now, also when
   * the new session is replaced in its turn. So are the notes of what routine
   * runs said until now; one an unsent dispatch carried is dropped when the
   * dispatch gives it back (`Ledger`).
   */
  const forgetConversation = Effect.fn("rotationRequests.forgetConversation")(function* (
    botId: BotId,
  ) {
    yield* dropDigests(botId);
    yield* sql`
      UPDATE conversations SET digest_from_position = (
        SELECT COALESCE(MAX(position) + 1, 0) FROM entries WHERE conversation_bot_id = ${botId}
      )
      WHERE bot_id = ${botId}
    `;
    yield* sql`
      DELETE FROM catch_up_notes
      WHERE bot_id = ${botId} AND consumed_dispatch_id IS NULL AND ${fromBeforeFreshStartSql(sql)}
    `;
  }, Effect.orDie);

  return {
    requestRotation,
    requestBotRotation,
    providerRestored,
    dropDigests,
    forgetConversation,
  };
};
