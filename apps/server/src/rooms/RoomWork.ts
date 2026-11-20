// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoomId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Ends the work addressed to a room when the room is archived or deleted, in
 * the transaction that does it (see `docs/architecture/server.md`, Rooms): its
 * pending wakes are cancelled, its open `ask` cards expire, and a Stop is
 * recorded for every member session whose turn, waiting turn or dispatch has
 * the room as its audience.
 *
 * That is the wake pipeline's work. Until it exists nothing is ever addressed
 * to a room, so there is nothing to end, and `layer` does nothing.
 */
export class RoomWork extends Context.Service<
  RoomWork,
  { readonly end: (roomId: RoomId) => Effect.Effect<void> }
>()("@j3-bots/server/rooms/RoomWork") {}

export const layer = Layer.succeed(RoomWork, RoomWork.of({ end: Effect.fn("RoomWork.end")(() => Effect.void) }));
