// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryTarget } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { type Audience, targetOf } from "./model.ts";

/**
 * Where entries for an audience go, unless its room was deleted or archived,
 * or the bot is no longer one of its members: then what the bot says there
 * reaches nobody, and nothing is woken for it there. Read from the database
 * rather than through `Rooms`, which ends a room's work through the turn
 * machinery.
 */
export const liveTarget =
  (sql: SqlClient.SqlClient) =>
  (botId: BotId, audience: Audience): Effect.Effect<EntryTarget | null> => {
    const target = targetOf(botId, audience);
    if (target === null || target._tag === "conversation") return Effect.succeed(target);
    return sql<{ readonly n: number }>`
      SELECT 1 AS n FROM rooms lt_room JOIN room_members lt_member
        ON lt_member.room_id = lt_room.id AND lt_member.bot_id = ${botId}
      WHERE lt_room.id = ${target.roomId} AND lt_room.status = 'active'
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows.length > 0 ? target : null)),
    );
  };
