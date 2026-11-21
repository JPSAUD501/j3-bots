// SPDX-License-Identifier: AGPL-3.0-or-later
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
