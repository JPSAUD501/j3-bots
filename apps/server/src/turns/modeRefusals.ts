// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId } from "@j3-bots/contracts";
import type { PermissionModeRefused } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import type { Entries } from "../entries/Entries.ts";
import { transactional } from "../persistence/transaction.ts";
import { conversation } from "./model.ts";
import { notices } from "./notices.ts";
import type { Readiness } from "./Readiness.ts";
import type { Signals } from "./Signals.ts";

/**
 * Whether the engine refused the permission mode of `botId`, a bot id or a
 * column holding one, at its settings as they stand: its main session is then
 * neither opened, aligned nor planned into until the bot's settings change or
 * the engine becomes ready again (`docs/architecture/server.md`, Every bot has
 * a main session).
 */
export const modeRefusedSql = (sql: SqlClient.SqlClient, botId: BotId | Statement.Fragment) => sql`
  EXISTS (
    SELECT 1 FROM bots mr_bot
    WHERE mr_bot.id = ${botId} AND mr_bot.mode_refused_revision IS mr_bot.settings_revision
  )
`;

/**
 * The rooms told that a member's permission mode is refused: it takes no part
 * there until the operator acts, and the rest of the room goes on without it
 * (`roomQueue` in the dispatcher). In the caller's transaction.
 */
export const roomRefusals = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const { notify } = notices(sql, entries);

  const roomsOf = SqlSchema.findAll({
    Request: BotId,
    Result: Schema.Struct({ room_id: RoomId }),
    execute: (botId) => sql`SELECT room_id FROM room_members WHERE bot_id = ${botId}`,
  });

  const refusedOf = SqlSchema.findAll({
    Request: Schema.Array(BotId),
    Result: Schema.Struct({ id: BotId }),
    execute: (botIds) => sql`
      SELECT id FROM bots WHERE ${sql.in("id", botIds)} AND ${modeRefusedSql(sql, sql`bots.id`)}
    `,
  });

  /** Tells the room, if it is active and the bot its member, that the bot takes no part. */
  const tell = (botId: BotId, roomId: RoomId) =>
    notify(botId, { _tag: "room", roomId }, { _tag: "member-mode-refused", botId }, null);

  /** Tells every room of the bot, as its own conversation is told of a refusal. */
  const refused = Effect.fn("roomRefusals.refused")(function* (botId: BotId) {
    for (const room of yield* roomsOf(botId)) yield* tell(botId, room.room_id);
  }, Effect.orDie);

  /**
   * Tells the room of each of `botIds`, members it has just taken in, whose
   * permission mode the engine refuses now: it was not in the room when its
   * refusal was told.
   */
  const joined = Effect.fn("roomRefusals.joined")(function* (
    roomId: RoomId,
    botIds: ReadonlyArray<BotId>,
  ) {
    if (botIds.length === 0) return;
    for (const bot of yield* refusedOf(botIds)) yield* tell(bot.id, roomId);
  }, Effect.orDie);

  return { refused, joined };
};

/**
 * The engine's refusals of a bot's permission mode: to open its main session
 * in, to change it to, or to run a turn there in. Each is recorded with the
 * bot's settings revision it was refused at, and stamped with the engine's
 * start generation (`Readiness.generation`) read before the call that met it.
 */
export const modeRefusals = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  readiness: Readiness["Service"],
  signals: Signals["Service"],
) => {
  const transaction = transactional(sql);
  const { notify } = notices(sql, entries);
  const rooms = roomRefusals(sql, entries);

  /**
   * Records that the engine refuses the bot's permission mode at the
   * settings revision `revision`, so it is not asked again until the bot's
   * settings change or the engine becomes ready again. A change committed
   * since that revision was read is recorded nothing for: the rotator, which
   * the change nudged, tries it. Nor is a refusal from an engine that was
   * ready under an older `generation`: the engine became ready again since,
   * perhaps under another policy, and cleared every refusal then
   * (`EngineSessions.engineStarted`), so the bot's main session is asked
   * again under the engine that is ready now. The generation is read in this
   * transaction, which the clearing never crosses, so a refusal is either
   * cleared or not written. The bot's conversation is told of a refusal at a
   * revision, or naming an allowed mode, it was not told of yet, so a refusal
   * the engine repeats after a restart is not told twice; each room it is a
   * member of is told with it, in one line naming the bot.
   */
  const refused = Effect.fn("modeRefusals.refused")(
    function* (botId: BotId, revision: number, refusal: PermissionModeRefused, generation: number) {
      if ((yield* readiness.generation) !== generation) {
        yield* sql.afterCommit(signals.rotations.fire);
        yield* sql.afterCommit(signals.dispatch.fire);
        return;
      }
      const recorded = yield* sql`
        UPDATE bots SET mode_refused_revision = ${revision}
        WHERE id = ${botId} AND settings_revision = ${revision}
        RETURNING id
      `;
      if (recorded.length === 0) return;
      const told = yield* sql`
        UPDATE bots
        SET mode_refusal_told_revision = ${revision}, mode_refusal_told_allowed = ${refusal.allowed}
        WHERE id = ${botId}
          AND (mode_refusal_told_revision IS NOT ${revision}
            OR mode_refusal_told_allowed IS NOT ${refusal.allowed})
        RETURNING id
      `;
      if (told.length === 0) return;
      yield* notify(
        botId,
        conversation,
        {
          _tag: "permission-mode-refused",
          permissionMode: refusal.permissionMode,
          allowed: refusal.allowed,
        },
        null,
      );
      yield* rooms.refused(botId);
    },
    transaction,
    Effect.orDie,
  );

  /**
   * The engine took the bot's settings for its main session, or a turn
   * there: a later refusal of its permission mode is told again, also one
   * the conversation was told of before.
   */
  const accepted = (botId: BotId | Statement.Fragment) =>
    sql`
      UPDATE bots SET mode_refusal_told_revision = NULL, mode_refusal_told_allowed = NULL
      WHERE id = ${botId} AND mode_refusal_told_revision IS NOT NULL
    `.pipe(Effect.orDie, Effect.asVoid);

  return { refused, accepted };
};
