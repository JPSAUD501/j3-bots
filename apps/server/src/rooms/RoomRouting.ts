// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, MessageEntry, Room, RoomId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Who a room message wakes (`docs/architecture/server.md`, Rooms): for the
 * operator's, the bots it mentions one at a time, every member for
 * `everyone`, the host for nobody; for a bot's, the members it addresses,
 * within the room's hop limit. It writes their `room` wakes in the caller's
 * transaction, the one that writes the message.
 *
 * Room turns come with rooms, in M3 (`docs/roadmap.md`). Until then `layer` wakes
 * nobody, and an operator's room message stays `pending`.
 */
export class RoomRouting extends Context.Service<
  RoomRouting,
  {
    readonly operatorMessage: (input: {
      readonly room: Room;
      readonly message: MessageEntry;
    }) => Effect.Effect<void>;
    /** A bot spoke in a room, in a turn whose wake had come `hops` hops from the operator. */
    readonly botMessage: (input: {
      readonly roomId: RoomId;
      readonly botId: BotId;
      readonly message: MessageEntry;
      readonly hops: number;
    }) => Effect.Effect<void>;
  }
>()("@j3-bots/server/rooms/RoomRouting") {}

export const layer = Layer.succeed(
  RoomRouting,
  RoomRouting.of({
    operatorMessage: Effect.fn("RoomRouting.operatorMessage")(() => Effect.void),
    botMessage: Effect.fn("RoomRouting.botMessage")(() => Effect.void),
  }),
);
