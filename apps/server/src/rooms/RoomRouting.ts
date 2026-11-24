// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, MessageEntry, Room } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DispatchSeq, RoomReason } from "../turns/model.ts";
import { type NewWake, Wakes } from "../turns/Wakes.ts";
import type { LiveRoom } from "./liveRoom.ts";

/** A room that takes messages. */
export type ActiveRoom = Extract<Room, { readonly status: "active" }>;

/** What became of a bot's room message's mentions. */
export type BotMessageRouted =
  /** Each mentioned member has its wake, unless the work that spoke was stopped. */
  | { readonly _tag: "routed" }
  /** The wakes would pass the room's hop limit, so none was written. */
  | { readonly _tag: "hop-limit"; readonly limit: number };

/**
 * Who a room message wakes (`docs/architecture/server.md`, Rooms). For the
 * operator's: the bots it mentions, in the order mentioned; every member, in
 * member order, for `everyone`; the host when it mentions nobody. For a
 * bot's: only the members its `say` lists in `mention`, within the room's hop
 * limit. Each wake is a `room` wake for the room, written in the caller's
 * transaction, the one that writes the message. The members then run one at a
 * time, oldest wake first, because a room runs one turn at a time
 * (`turns/Pipeline.ts`).
 */
export class RoomRouting extends Context.Service<
  RoomRouting,
  {
    readonly operatorMessage: (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) => Effect.Effect<void>;
    /**
     * A bot spoke in a room and listed `mention`, members other than itself,
     * already checked: in a `say`, or in the kickoff of a room it started,
     * which `reason` tells the members. A wake it causes is `hops` hops from
     * the operator (Budgets); `seq` is the dispatch that began the speaking
     * turn's work, `null` for a turn no dispatch began.
     */
    readonly botMessage: (input: {
      readonly room: LiveRoom;
      readonly botId: BotId;
      readonly message: MessageEntry;
      readonly mention: ReadonlyArray<BotId>;
      readonly reason: Extract<RoomReason, "kickoff" | "mentioned">;
      readonly hops: number;
      readonly seq: DispatchSeq | null;
    }) => Effect.Effect<BotMessageRouted>;
  }
>()("@j3-bots/server/rooms/RoomRouting") {}

/** Who the operator's room message wakes, in order, and why. */
const addressed = (
  room: ActiveRoom,
  message: MessageEntry,
): ReadonlyArray<readonly [BotId, RoomReason]> => {
  const { mentions } = message;
  if (mentions._tag === "everyone") return room.members.map((id) => [id, "everyone"]);
  if (mentions.ids.length > 0) return mentions.ids.map((id) => [id, "mentioned"]);
  return [[room.hostId, "host"]];
};

export const layer = Layer.effect(
  RoomRouting,
  Effect.gen(function* () {
    const wakes = yield* Wakes;

    const operatorMessage = Effect.fn("RoomRouting.operatorMessage")(function* (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) {
      const audience = { _tag: "room", roomId: input.room.id } as const;
      yield* wakes.record(
        addressed(input.room, input.message).map(([botId, reason]): NewWake => ({
          botId,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: input.message.id, reason },
          sourceEntryId: input.message.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        })),
      );
    });

    const botMessage = Effect.fn("RoomRouting.botMessage")(function* (input: {
      readonly room: LiveRoom;
      readonly botId: BotId;
      readonly message: MessageEntry;
      readonly mention: ReadonlyArray<BotId>;
      readonly reason: Extract<RoomReason, "kickoff" | "mentioned">;
      readonly hops: number;
      readonly seq: DispatchSeq | null;
    }) {
      if (input.mention.length === 0) return { _tag: "routed" } as const;
      if (input.hops > input.room.hopLimit) {
        return { _tag: "hop-limit", limit: input.room.hopLimit } as const;
      }
      const audience = { _tag: "room", roomId: input.room.id } as const;
      // The speaking turn's work: a Stop that covers it, or the room's
      // archival, leaves these wakes unwritten (`Wakes.record`).
      yield* wakes.record(
        input.mention.map((botId): NewWake => ({
          botId,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: input.message.id, reason: input.reason },
          sourceEntryId: input.message.id,
          hops: input.hops,
          retryOf: null,
          cause: { _tag: "teammate", senderId: input.botId, audience, seq: input.seq },
        })),
      );
      return { _tag: "routed" } as const;
    });

    return RoomRouting.of({ operatorMessage, botMessage });
  }),
);
