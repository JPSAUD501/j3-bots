import * as Schema from "effect/Schema";
import { BotId, Label, PositiveInt, RoomId } from "./base.ts";

/** Two to six bots. Order matters: `@everyone` wakes members in this order. */
export const RoomMembers = Schema.Array(BotId).check(Schema.isMinLength(2), Schema.isMaxLength(6));

export const Room = Schema.Struct({
  id: RoomId,
  name: Label,
  members: RoomMembers,
  /** Answers when the operator addresses nobody. Always a member. */
  hostId: BotId,
  /** Consecutive bot-caused turns allowed before the room waits for the operator. */
  hopLimit: PositiveInt,
  pinned: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
});
export type Room = typeof Room.Type;
