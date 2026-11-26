// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

/** What decides whether a bot may show or hide a bot or a room of the operator's. */
export interface VisibilityOf {
  readonly name: string;
  /** The operator's primary bot, which only they show or hide. */
  readonly primary: boolean;
  /** The bot that made it with `create_bot` or `start_room`, while that bot exists. */
  readonly madeBy: BotId | null;
  /** The operator chose whether it shows, by making it, showing it or hiding it. */
  readonly byOperator: boolean;
}

/** The bot that asks to show or hide something. */
export interface VisibilityCaller {
  readonly id: BotId;
  readonly primary: boolean;
}

/** Why a bot's `set_visibility` changed nothing, in words the bot reads. */
export class VisibilityRefused extends Schema.TaggedError<VisibilityRefused>()(
  "VisibilityRefused",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Whether `caller` may show or hide `target` (decision 0050), or why not. The
 * operator's choice always wins: what they made, showed or hid stays as they
 * left it for every bot. Otherwise the primary bot may change any bot or room
 * but itself, and any other bot only those it made.
 */
export const visibilityRefusal = (
  caller: VisibilityCaller,
  target: VisibilityOf,
): VisibilityRefused | undefined => {
  if (target.primary) {
    return new VisibilityRefused({
      reason: `Nothing changed: ${target.name} is your user's primary bot, which only your user can show or hide.`,
    });
  }
  if (target.byOperator) {
    return new VisibilityRefused({
      reason: `Nothing changed: your user chose whether ${target.name} shows in their list, so only they can change it. Tell them if you think it should change.`,
    });
  }
  if (caller.primary || target.madeBy === caller.id) return undefined;
  return new VisibilityRefused({
    reason: `Nothing changed: you can show or hide only the bots and rooms you made, and ${target.name} is not one of them.`,
  });
};

/** What a `set_visibility` leaves: the bot or room, and whether it is hidden now. */
export const Shown = Schema.Struct({ id: Schema.String, hidden: Schema.Boolean });
export type Shown = typeof Shown.Type;

/**
 * A `set_visibility` as its receipt stores it, the same for a bot and a room:
 * a retry of one that went through gets its result back whichever it finds
 * the id to be then, a bot deleted meanwhile included.
 */
export const visibilityCommand = (input: {
  readonly caller: BotId;
  readonly id: string;
  readonly hidden: boolean;
}) => ({
  method: "set_visibility",
  payload: { caller: input.caller, id: input.id, hidden: input.hidden },
  result: Shown,
});
