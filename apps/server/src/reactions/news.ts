// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryId, MessageEntry, Reactor, RoomId } from "@j3-bots/contracts";
import type { ReactionNews, ReactionWho, TeammateRef } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Entries } from "../entries/Entries.ts";
import type { LiveRoom } from "../rooms/liveRoom.ts";

/** How much of the message reacted to an envelope quotes, so the bot knows which it is. */
const EXCERPT_LENGTH = 300;

const excerptOf = (message: MessageEntry): string => {
  const text = message.text.trim();
  const shown = text === "" ? message.attachments.map((file) => file.name).join(", ") : text;
  return shown.length <= EXCERPT_LENGTH ? shown : `${shown.slice(0, EXCERPT_LENGTH)}…`;
};

/**
 * The reactions on a message as `botId`'s envelope tells them
 * (`docs/architecture/server.md`, Reactions), read when the envelope is
 * written so a change since is told as it ended. `null` when there is nothing
 * left to tell: the message is gone or J3 Bots' own, its room is no longer active or the
 * bot no longer in it, no one but
 * the bot reacts to it, or, for the wake the operator's reaction caused,
 * their reaction was taken off.
 */
export const reactionNews =
  (deps: {
    readonly entries: Entries["Service"];
    readonly roomOf: (roomId: RoomId) => Effect.Effect<Option.Option<LiveRoom>>;
    readonly teammate: (botId: BotId) => Effect.Effect<TeammateRef>;
  }) =>
  (input: {
    readonly botId: BotId;
    readonly entryId: EntryId;
    /** For the wake: only the operator's reaction makes it worth telling. */
    readonly forWake: boolean;
  }): Effect.Effect<ReactionNews | null> =>
    Effect.gen(function* () {
      const found = yield* deps.entries.find(input.entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "message") return null;
      const { target } = found.value;
      const message: MessageEntry = found.value.entry;
      // J3 Bots' own messages take no reactions (`Reactions`).
      const { author } = message;
      if (author._tag === "system") return null;
      let room: ReactionNews["room"] = null;
      if (target._tag === "room") {
        const live = yield* deps.roomOf(target.roomId);
        // A bot no longer in the room hears nothing more of it.
        if (Option.isNone(live) || !live.value.members.includes(input.botId)) return null;
        room = { id: live.value.id, name: live.value.name };
      }
      const reactions = message.reactions ?? [];
      const others = reactions.some(
        (reaction) => reaction.by._tag !== "bot" || reaction.by.botId !== input.botId,
      );
      if (!others) return null;
      if (input.forWake && !reactions.some((reaction) => reaction.by._tag === "operator")) {
        return null;
      }
      const who = (by: Reactor): Effect.Effect<ReactionWho> => {
        if (by._tag !== "bot") return Effect.succeed("user");
        return by.botId === input.botId ? Effect.succeed("you") : deps.teammate(by.botId);
      };
      const [first, ...rest] = yield* Effect.forEach(reactions, (reaction) =>
        Effect.map(who(reaction.by), (from) => ({ from, emoji: reaction.emoji })),
      );
      if (first === undefined) return null;
      return {
        room,
        message: { id: message.id, from: yield* who(author), excerpt: excerptOf(message) },
        reactions: [first, ...rest],
      };
    });
