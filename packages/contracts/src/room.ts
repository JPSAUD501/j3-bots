// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BotId, Label, RoomId } from "./base.ts";
import { TurnWork } from "./work.ts";

/** The most bots a room has. */
export const MAX_ROOM_MEMBERS = 6;

/** Two to six bots, all equal. The members a room message wakes are woken in this order. */
export const RoomMembers = Schema.Array(BotId).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(MAX_ROOM_MEMBERS),
);

export const RoomName = Label;

/**
 * A room counts rounds of its bots answering each other since the operator's
 * word last reached it (decision 0042). Their word is round 0: their message
 * there, a bot's kickoff, or a request of theirs a bot relayed. A bot's
 * message there is one round past the newest round it answers. An envelope
 * whose reply would be this round or later says the conversation is closing:
 * answer only if it is essential.
 */
export const ROOM_CLOSING_ROUND = 3;

/**
 * A bot's room message of a round past this one is posted but wakes nobody,
 * and the room shows one `chain-stopped` notice (`room`), until the operator's
 * word reaches it again (`ROOM_CLOSING_ROUND`).
 */
export const ROOM_QUIET_ROUND = 4;

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
  pinned: Schema.Boolean,
  /**
   * Kept out of the roster, among the hidden conversations, as a hidden bot
   * is (`Bot.hidden`): it still runs and notifies. False from a server that
   * predates it.
   */
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: Schema.DateTimeUtc,
};

/**
 * A room that takes messages. An archived room stays readable and takes none.
 * The operator archives a room with `room.update`, and a room is archived when
 * deleting bots leaves it with fewer than two members, so an archived room may
 * have fewer.
 */
export const Room = Schema.Union([
  Schema.Struct({
    ...roomFields,
    status: Schema.Literal("active"),
    members: RoomMembers,
    /**
     * Read as `none` from a server that does not send it, which offers no
     * Stop of the room.
     */
    work: RoomWorkState.pipe(Schema.withDecodingDefaultKey(Effect.succeed("none"))),
    /**
     * A member's AI ignores the Stop of the room's work: the engine asked it to
     * stop and it has not confirmed in time. Clients offer Force stop in place
     * of the Stop under way while it is true (`room.forceStop`). False from a
     * server that predates it.
     */
    forceStop: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    /**
     * The members answering now, in member order: those whose turn for the
     * room runs and those woken whose turn has yet to start. Empty unless
     * `work` is `running`, and from a server that does not send it.
     */
    answering: Schema.Array(BotId)
      .check(Schema.isMaxLength(MAX_ROOM_MEMBERS))
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    /**
     * The plan and little ones of each member's turn for the room, while
     * that work is under way (`work` is `running`), in member order: a
     * member whose turn has neither is left out. A room's turn shows them
     * here only, never in the member's own conversation. Empty from a server
     * that does not send it.
     */
    memberWork: Schema.Array(Schema.Struct({ botId: BotId, work: TurnWork }))
      .check(Schema.isMaxLength(MAX_ROOM_MEMBERS))
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  }),
  Schema.Struct({
    ...roomFields,
    status: Schema.Literal("archived"),
    members: Schema.Array(BotId).check(Schema.isMaxLength(MAX_ROOM_MEMBERS)),
    archivedAt: Schema.DateTimeUtc,
  }),
]);
export type Room = typeof Room.Type;
