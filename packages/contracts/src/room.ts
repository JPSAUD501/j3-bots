// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BotId, Label, PositiveInt, RoomId } from "./base.ts";

/** The most bots a room has. */
export const MAX_ROOM_MEMBERS = 6;

/** Two to six bots. Order matters: `@everyone` wakes members in this order. */
export const RoomMembers = Schema.Array(BotId).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(MAX_ROOM_MEMBERS),
);

export const RoomName = Label;

/** Consecutive bot-caused turns allowed before the room waits for the operator. */
export const RoomHopLimit = PositiveInt;

/**
 * Whether work addressed to an active room is under way, so a client offers
 * its Stop: `running` while a turn for the room is admitted or runs, a wake
 * or dispatch for it waits, or work a turn of the room left running in the
 * background may still run; `stopping` while a Stop of the room has not
 * settled. Work its members do for anyone else does not count.
 */
export const RoomWorkState = Schema.Literals(["none", "running", "stopping"]);
export type RoomWorkState = typeof RoomWorkState.Type;

const roomFields = {
  id: RoomId,
  name: RoomName,
  hopLimit: RoomHopLimit,
  pinned: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
};

/**
 * A room that takes messages. An archived room stays readable and takes none.
 * The operator archives a room with `room.update`, and a room is archived when
 * deleting bots leaves it with fewer than two members, so an archived room may
 * have fewer and no host.
 */
export const Room = Schema.Union([
  Schema.Struct({
    ...roomFields,
    status: Schema.Literal("active"),
    members: RoomMembers,
    /** Answers when the operator addresses nobody. Always a member. */
    hostId: BotId,
    /**
     * Read as `none` from a server that does not send it, which offers no
     * Stop of the room.
     */
    work: RoomWorkState.pipe(Schema.withDecodingDefaultKey(Effect.succeed("none"))),
  }),
  Schema.Struct({
    ...roomFields,
    status: Schema.Literal("archived"),
    members: Schema.Array(BotId).check(Schema.isMaxLength(MAX_ROOM_MEMBERS)),
    hostId: Schema.NullOr(BotId),
    archivedAt: Schema.DateTimeUtc,
  }),
]);
export type Room = typeof Room.Type;
