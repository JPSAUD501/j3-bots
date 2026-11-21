// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, RoomId, RoomWorkState } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";

const WorkRow = Schema.Struct({ room_id: RoomId, work: RoomWorkState });

/**
 * Whether work addressed to each active room is under way, for the roster
 * (`docs/architecture/server.md`, Rooms), read from what the turn machinery
 * recorded. `stopping` while a room Stop has a target not settled; else
 * `running` while a wake for the room waits, a dispatch for it is not
 * settled, a session has a turn for it admitted, or one of its turns runs or
 * may still have background work running, in a session the engine still
 * has; else `none`. A member's work for anyone else never counts.
 */
export class RoomStates extends Context.Service<
  RoomStates,
  {
    /** The work of each of these rooms, by id; a room that does not exist is left out. */
    readonly workOf: (
      roomIds: ReadonlyArray<RoomId>,
    ) => Effect.Effect<ReadonlyMap<RoomId, RoomWorkState>>;
    /** The work of each active room the bot is a member of, by id. */
    readonly workOfBot: (botId: BotId) => Effect.Effect<ReadonlyMap<RoomId, RoomWorkState>>;
  }
>()("@j3-bots/server/turns/RoomStates") {}

export const layer = Layer.effect(
  RoomStates,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /** The work of the rooms `rooms` selects, as `rs_room`. */
    const select = (rooms: Statement.Fragment) => sql`
      SELECT rs_room.id AS room_id, CASE
        WHEN EXISTS (
          SELECT 1 FROM stops rs_stop JOIN stop_targets rs_target ON rs_target.stop_id = rs_stop.id
          WHERE rs_stop.scope = 'room' AND rs_stop.room_id = rs_room.id
            AND rs_target.stopped_at IS NULL
        ) THEN 'stopping'
        WHEN EXISTS (
          SELECT 1 FROM wakes rs_wake
          WHERE rs_wake.status = 'pending' AND rs_wake.audience = 'room'
            AND rs_wake.audience_room_id = rs_room.id
        )
        OR EXISTS (
          SELECT 1 FROM dispatches rs_dispatch
          WHERE rs_dispatch.audience_room_id = rs_room.id
            AND rs_dispatch.status IN ('intended', 'accepted', 'delivered')
        )
        OR EXISTS (
          SELECT 1 FROM sessions rs_admitting
          WHERE rs_admitting.admitted_room_id = rs_room.id AND rs_admitting.lost_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM turns rs_turn JOIN sessions rs_session ON rs_session.id = rs_turn.session_id
          WHERE rs_turn.audience = 'room' AND rs_turn.audience_room_id = rs_room.id
            AND rs_session.lost_at IS NULL AND rs_session.engine_retired_at IS NULL
            AND (rs_turn.finished_at IS NULL OR rs_turn.background_pending = 1)
        ) THEN 'running'
        ELSE 'none'
      END AS work
      FROM rooms rs_room
      WHERE rs_room.status = 'active' AND ${rooms}
    `;

    const byRooms = SqlSchema.findAll({
      Request: Schema.Array(RoomId),
      Result: WorkRow,
      execute: (roomIds) => select(sql.in("rs_room.id", roomIds)),
    });

    const byBot = SqlSchema.findAll({
      Request: Schema.String,
      Result: WorkRow,
      execute: (botId) =>
        select(sql`rs_room.id IN (SELECT room_id FROM room_members WHERE bot_id = ${botId})`),
    });

    const toMap = (rows: ReadonlyArray<typeof WorkRow.Type>) =>
      new Map(rows.map((row) => [row.room_id, row.work] as const));

    const workOf = Effect.fn("RoomStates.workOf")(function* (roomIds: ReadonlyArray<RoomId>) {
      if (roomIds.length === 0) return new Map<RoomId, RoomWorkState>();
      return toMap(yield* byRooms(roomIds));
    }, Effect.orDie);

    const workOfBot = Effect.fn("RoomStates.workOfBot")(function* (botId: BotId) {
      return toMap(yield* byBot(botId));
    }, Effect.orDie);

    return RoomStates.of({ workOf, workOfBot });
  }),
);
