// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, type MessageEntry, type Room, ROOM_QUIET_AFTER } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import type { DispatchSeq, RoomReason } from "../turns/model.ts";
import { notices } from "../turns/notices.ts";
import { type NewWake, Wakes } from "../turns/Wakes.ts";
import type { LiveRoom } from "./liveRoom.ts";

/** A room that takes messages. */
export type ActiveRoom = Extract<Room, { readonly status: "active" }>;

/** What became of a bot's room message's wakes. */
export type BotMessageRouted =
  /** The members it wakes have their wakes, unless the work that spoke was stopped. */
  | { readonly _tag: "routed" }
  /**
   * The room's bots had already said `ROOM_QUIET_AFTER` messages since the
   * operator last wrote, so none was written.
   */
  | { readonly _tag: "quiet" };

/**
 * Whose word a bot's room message carries, which decides whether it counts
 * (`docs/architecture/server.md`, Rooms):
 *
 * - `kickoff`: the first message of a room the bot started, which a bot does
 *   only in a turn the operator spoke in. It starts the room's count.
 * - `relayed`: the first `message_bot` to the room from a turn the operator
 *   spoke in, outside the room's own turns: their request, brought to the
 *   room. It starts the count again, as their own message there would; the
 *   turn's later posts there are `bot`.
 * - `bot`: any other, the bot's own. It counts.
 */
export type BotWord = "kickoff" | "relayed" | "bot";

/**
 * Who a room message wakes (`docs/architecture/server.md`, Rooms), the
 * operator's message and a bot's alike: the members it mentions, or every
 * member but its author when it mentions nobody or everyone. Every member
 * reads it in its next envelope either way. The room counts its bots'
 * messages since the operator's word last reached it: a message of theirs
 * there, a bot's kickoff, or a request of theirs a bot relayed
 * (`rooms.bot_streak`, `BotWord`). Past `ROOM_QUIET_AFTER` a bot's message
 * wakes nobody, and the first such message shows one `chain-stopped` notice
 * in the room until their word reaches it again. Each wake is a `room` wake
 * for the room, written in the caller's transaction, the one that writes the
 * message.
 */
export class RoomRouting extends Context.Service<
  RoomRouting,
  {
    readonly operatorMessage: (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) => Effect.Effect<void>;
    /**
     * A bot spoke in a room: in a `say` or a `message_bot` to it, in the
     * `kickoff` of a room it started, or in the engine's own speech of a room
     * turn; `word` says whether it carries the operator's word. Its mentions
     * are already checked to be other members. `seq` is the dispatch that began the speaking turn's
     * work, `null` for a turn no dispatch began. A message of work the
     * operator `stopped` is in the room, so it counts, but wakes nobody.
     */
    readonly botMessage: (input: {
      readonly room: LiveRoom;
      readonly botId: BotId;
      readonly message: MessageEntry;
      readonly word: BotWord;
      readonly seq: DispatchSeq | null;
      readonly stopped: boolean;
    }) => Effect.Effect<BotMessageRouted>;
  }
>()("@j3-bots/server/rooms/RoomRouting") {}

/**
 * The members a message wakes, in member order, and why: those it mentions,
 * or, mentioning nobody or everyone, every member but its author.
 */
const woken = (
  members: ReadonlyArray<BotId>,
  message: MessageEntry,
  unaddressed: "user" | "member" | "kickoff",
): ReadonlyArray<readonly [BotId, RoomReason]> => {
  const author = message.author._tag === "bot" ? message.author.botId : null;
  const others = members.filter((id) => id !== author);
  const { mentions } = message;
  if (mentions._tag === "everyone") {
    return others.map((id) => [id, unaddressed === "kickoff" ? "kickoff" : "everyone"] as const);
  }
  if (mentions.ids.length === 0) return others.map((id) => [id, unaddressed] as const);
  return others
    .filter((id) => mentions.ids.includes(id))
    .map((id) => [id, unaddressed === "kickoff" ? "kickoff" : "addressed"] as const);
};

export const layer = Layer.effect(
  RoomRouting,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wakes = yield* Wakes;
    const { notify } = notices(sql, yield* Entries);

    const restart = (room: { readonly id: Room["id"] }) =>
      sql`UPDATE rooms SET bot_streak = 0 WHERE id = ${room.id}`.pipe(Effect.orDie);

    /** One more bot's message in the room, and how many there are now. */
    const counted = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ bot_streak: Schema.Int }),
      execute: (id) => sql`
        UPDATE rooms SET bot_streak = bot_streak + 1 WHERE id = ${id} RETURNING bot_streak
      `,
    });

    const operatorMessage = Effect.fn("RoomRouting.operatorMessage")(function* (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) {
      yield* restart(input.room);
      const audience = { _tag: "room", roomId: input.room.id } as const;
      yield* wakes.record(
        woken(input.room.members, input.message, "user").map(([botId, reason]): NewWake => ({
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
      readonly word: BotWord;
      readonly seq: DispatchSeq | null;
      readonly stopped: boolean;
    }) {
      const audience = { _tag: "room", roomId: input.room.id } as const;
      if (input.word !== "bot") yield* restart(input.room);
      else {
        const { bot_streak: streak } = yield* counted(input.room.id).pipe(Effect.orDie);
        if (streak > ROOM_QUIET_AFTER) {
          if (streak === ROOM_QUIET_AFTER + 1) {
            yield* notify(input.botId, audience, { _tag: "chain-stopped", limit: "room" }, null);
          }
          return { _tag: "quiet" } as const;
        }
      }
      if (input.stopped) return { _tag: "routed" } as const;
      // The speaking turn's work: a Stop that covers it, or the room's
      // archival, leaves these wakes unwritten (`Wakes.record`). A room
      // counts its own messages, so its wakes carry no hops: a teammate
      // message a member sends from them starts a chain of its own.
      yield* wakes.record(
        woken(
          input.room.members,
          input.message,
          input.word === "kickoff" ? "kickoff" : "member",
        ).map(([botId, reason]): NewWake => ({
          botId,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: input.message.id, reason },
          sourceEntryId: input.message.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "teammate", senderId: input.botId, audience, seq: input.seq },
        })),
      );
      return { _tag: "routed" } as const;
    });

    return RoomRouting.of({ operatorMessage, botMessage });
  }),
);
