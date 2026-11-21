// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Stops and ends the work addressed to a room, in the transaction that asks
 * for it (see `docs/architecture/server.md`, Rooms). The turn machinery
 * provides it (`turns/Stops.ts`), below the rooms that call it.
 */
export class RoomWork extends Context.Service<
  RoomWork,
  {
    /**
     * The operator's Stop of the room (`room.stop`): its pending wakes are
     * cancelled, and a room Stop is recorded for every member whose turn,
     * waiting turn, dispatch, or background work a turn of the room started,
     * has the room as its audience. Its cards stay open.
     */
    readonly stop: (roomId: RoomId) => Effect.Effect<void>;
    /** The room is archived or deleted: it is stopped, and its open `ask` cards expire. */
    readonly end: (roomId: RoomId) => Effect.Effect<void>;
    /**
     * The bots left the room: their wakes still held for it are cancelled,
     * and their room dispatches never sent released with their wakes
     * cancelled, in the caller's transaction, so none of them reads what is
     * said there after it left. The operator's messages they never received
     * count them no more, as for a deleted bot: no wake of theirs for the room
     * that did not finish, failed ones included. Their room notices offer no
     * Retry, their open `ask` cards for the room expire, and a room Stop ends
     * what they still run for it. When anything was cancelled or released,
     * the dispatcher is nudged once the transaction commits.
     */
    readonly leave: (roomId: RoomId, botIds: ReadonlyArray<BotId>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/rooms/RoomWork") {}
