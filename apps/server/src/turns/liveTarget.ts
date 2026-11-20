// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryTarget } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { type Audience, targetOf } from "./model.ts";

/**
 * Where entries for an audience go, unless its room was deleted or archived:
 * then what the bot says there reaches nobody. Read from the database rather
 * than through `Rooms`, which ends a room's work through the turn machinery.
 */
export const liveTarget =
  (sql: SqlClient.SqlClient) =>
  (botId: BotId, audience: Audience): Effect.Effect<EntryTarget | null> => {
    const target = targetOf(botId, audience);
    if (target === null || target._tag === "conversation") return Effect.succeed(target);
    return sql<{
      readonly status: string;
    }>`SELECT status FROM rooms WHERE id = ${target.roomId}`.pipe(
      Effect.orDie,
      Effect.map(([room]) => (room?.status === "active" ? target : null)),
    );
  };
