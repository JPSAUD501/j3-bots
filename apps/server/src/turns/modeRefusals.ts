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
 * Whether the room `roomId` was told that the bot `botId`, a member, takes no
 * part there, since its conversation was last told of a refusal of its
 * permission mode: one of its `member-mode-refused` lines for the bot is
 * newer than the conversation's last `permission-mode-refused` notice. Each
 * refusal the conversation is told of, the first after a turn the engine took
 * included, so asks every room of the bot afresh; a room that took the bot in
 * since was never told. Both are a column or a value.
 */
const roomToldSql = (
  sql: SqlClient.SqlClient,
  roomId: RoomId | Statement.Fragment,
  botId: BotId | Statement.Fragment,
) => sql`
  EXISTS (
    SELECT 1 FROM entries rt_line
    WHERE rt_line.room_id = ${roomId} AND rt_line.kind = 'notice'
      AND json_extract(rt_line.body_json, '$.notice._tag') = 'member-mode-refused'
      AND json_extract(rt_line.body_json, '$.notice.botId') = ${botId}
      AND rt_line.seq > COALESCE((
        SELECT MAX(rt_told.seq) FROM entries rt_told
        WHERE rt_told.conversation_bot_id = ${botId} AND rt_told.kind = 'notice'
          AND json_extract(rt_told.body_json, '$.notice._tag') = 'permission-mode-refused'
      ), 0)
  )
`;

/**
 * The rooms told that a member's permission mode is refused: it takes no part
 * there until the operator acts, and the rest of the room goes on without it
 * (`roomQueue` in the dispatcher). Each room is told once for each refusal
 * the bot's conversation is told of (`roomToldSql`). In the caller's
 * transaction.
 */
export const roomRefusals = (sql: SqlClient.SqlClient, entries: Entries["Service"]) => {
  const { notify } = notices(sql, entries);

  const untoldRooms = SqlSchema.findAll({
    Request: BotId,
    Result: Schema.Struct({ room_id: RoomId }),
    execute: (botId) => sql`
      SELECT room_id FROM room_members
      WHERE bot_id = ${botId} AND NOT ${roomToldSql(sql, sql`room_members.room_id`, sql`${botId}`)}
    `,
  });

  const untoldRefused = SqlSchema.findAll({
    Request: Schema.Struct({ roomId: RoomId, botIds: Schema.Array(BotId) }),
    Result: Schema.Struct({ id: BotId }),
    execute: ({ roomId, botIds }) => sql`
      SELECT id FROM bots
      WHERE ${sql.in("id", botIds)} AND ${modeRefusedSql(sql, sql`bots.id`)}
        AND NOT ${roomToldSql(sql, sql`${roomId}`, sql`bots.id`)}
    `,
  });

  /** Tells the room, if it is active and the bot its member, that the bot takes no part. */
  const tell = (botId: BotId, roomId: RoomId) =>
    notify(botId, { _tag: "room", roomId }, { _tag: "member-mode-refused", botId }, null);

  /**
   * Tells every room of the bot not told yet of its refusal as it stands,
   * after its conversation was told, or found it was told before.
   */
  const refused = Effect.fn("roomRefusals.refused")(function* (botId: BotId) {
    for (const room of yield* untoldRooms(botId)) yield* tell(botId, room.room_id);
  }, Effect.orDie);

  /**
   * Tells the room of each of `botIds`, members it has just taken in, whose
   * permission mode the engine refuses now, unless it was told already. One
   * not refused now is told with its next refusal (`refused`).
   */
  const joined = Effect.fn("roomRefusals.joined")(function* (
    roomId: RoomId,
    botIds: ReadonlyArray<BotId>,
  ) {
    if (botIds.length === 0) return;
    for (const bot of yield* untoldRefused({ roomId, botIds })) yield* tell(bot.id, roomId);
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
   * member of is told once for each refusal its conversation is told of, in
   * one line naming the bot, also a room it joined after the conversation
   * was told (`roomRefusals`).
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
      if (told.length > 0) {
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
      }
      // Asked also when the conversation was told before: a room may have
      // taken the bot in while no refusal of it stood, after a restart.
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
