// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Ends the work addressed to a room when the room is archived or deleted, in
 * the transaction that does it (see `docs/architecture/server.md`, Rooms): its
 * pending wakes are cancelled, its open `ask` cards expire, and a Stop is
 * recorded for every member session whose turn, waiting turn or dispatch has
 * the room as its audience. The turn machinery provides it
 * (`turns/Stops.ts`), below the rooms that call it.
 */
export class RoomWork extends Context.Service<
  RoomWork,
  {
    readonly end: (roomId: RoomId) => Effect.Effect<void>;
    /**
     * The bots left the room: their wakes still held for it are cancelled,
     * and their room dispatches never sent released with their wakes
     * cancelled, in the caller's transaction, so none of them reads what is
     * said there after it left. The operator's messages they never received
     * count them no more, as for a deleted bot.
     */
    readonly leave: (roomId: RoomId, botIds: ReadonlyArray<BotId>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/rooms/RoomWork") {}
