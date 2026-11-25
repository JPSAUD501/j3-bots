// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** An active room as routing reads it: who is in it, in member order. */
export interface LiveRoom {
  readonly id: RoomId;
  readonly name: string;
  readonly members: ReadonlyArray<BotId>;
}

const RoomRow = Schema.Struct({ id: RoomId, name: Schema.String });

/**
 * The room, if it is active, read in the caller's transaction straight from
 * the database: the turn machinery reads it below `Rooms`, which ends a
 * room's work through that machinery.
 */
export const liveRoom = (sql: SqlClient.SqlClient) => {
  const room = SqlSchema.findOneOption({
    Request: RoomId,
    Result: RoomRow,
    execute: (id) => sql`
      SELECT id, name FROM rooms WHERE id = ${id} AND status = 'active'
    `,
  });
  const members = SqlSchema.findAll({
    Request: RoomId,
    Result: Schema.Struct({ bot_id: BotId }),
    execute: (id) => sql`SELECT bot_id FROM room_members WHERE room_id = ${id} ORDER BY position`,
  });
  return (roomId: RoomId): Effect.Effect<Option.Option<LiveRoom>> =>
    Effect.gen(function* () {
      const found = yield* room(roomId);
      if (Option.isNone(found)) return Option.none();
      return Option.some({
        id: found.value.id,
        name: found.value.name,
        members: (yield* members(roomId)).map((row) => row.bot_id),
      });
    }).pipe(Effect.orDie);
};
