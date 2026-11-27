// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Addressing, Draft } from "@j3-bots/client-runtime";
import type { Bot, BotId, EntryTarget, Room, RoomId, RosterItem } from "@j3-bots/contracts";
import { addressed, conversationMentionables, named } from "@j3-bots/client-runtime/presentation";
import { roomAvatarMembers } from "./avatar/BotAvatar";
import type { MentionCandidate, MentionChoices } from "./Composer";

/** The bots and the rooms of the roster, by id. */
const byId = (roster: ReadonlyArray<RosterItem>) => {
  const bots = new Map<BotId, Bot>();
  const rooms = new Map<RoomId, Room>();
  for (const one of roster) {
    if (one._tag === "bot") bots.set(one.bot.id, one.bot);
    else rooms.set(one.room.id, one.room);
  }
  return { bots, rooms };
};

/** A bot as a mention list offers it: by its name, its title and its face. */
const face = (bot: Bot): MentionCandidate => ({
  _tag: "bot",
  id: bot.id,
  name: bot.profile.name,
  title: bot.profile.title,
  avatar: bot.profile.avatar,
});

/**
 * What `@` offers in the draft of `target`, by the names the roster shows. In a
 * room, its members, each by its face, and `@everyone`. In a bot's
 * conversation, what `conversationChoicesOf` offers; only once the server
 * takes it (`conversationMentions`), and nothing before.
 */
export function mentionChoicesOf(
  target: EntryTarget,
  roster: ReadonlyArray<RosterItem>,
  conversationMentions: boolean,
): MentionChoices | undefined {
  if (target._tag !== "room") {
    return conversationMentions ? conversationChoicesOf(target.botId, roster) : undefined;
  }
  const { bots, rooms } = byId(roster);
  const room = rooms.get(target.roomId);
  if (room === undefined) return undefined;
  return {
    candidates: room.members.flatMap((id) => {
      const bot = bots.get(id);
      return bot === undefined ? [] : [face(bot)];
    }),
    everyone: true,
  };
}

/**
 * What `@` offers in the conversation of `botId`: the operator's other bots,
 * each by its face, and the rooms that bot is a member of, each by its mark.
 */
export function conversationChoicesOf(
  botId: BotId,
  roster: ReadonlyArray<RosterItem>,
): MentionChoices {
  const { bots, rooms } = byId(roster);
  return {
    candidates: conversationMentionables(botId, [...bots.values()], [...rooms.values()]).flatMap(
      (candidate): ReadonlyArray<MentionCandidate> => {
        if (candidate._tag === "bot") {
          const bot = bots.get(candidate.id);
          return bot === undefined ? [] : [face(bot)];
        }
        const room = rooms.get(candidate.id);
        return room === undefined ? [] : [{ ...candidate, members: roomAvatarMembers(room, bots) }];
      },
    ),
    everyone: false,
  };
}

/**
 * Whom the draft of `target` is for as it stands, where only mentions
 * picked, and still standing, count: in a room, the members it wakes; in a
 * bot's conversation, the bots and rooms it mentions.
 */
export function addressingOf(
  target: EntryTarget,
  draft: Draft,
  roster: ReadonlyArray<RosterItem>,
  choices: MentionChoices | undefined,
): Addressing | undefined {
  if (target._tag === "room") {
    const room = byId(roster).rooms.get(target.roomId);
    return room === undefined ? undefined : addressed(draft.text, draft.mentions, room.members);
  }
  return choices === undefined ? undefined : named(draft.text, draft.mentions, choices.candidates);
}
