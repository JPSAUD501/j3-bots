// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, Bot, BotId, ConversationMention } from "@j3-bots/contracts";
import { createContext, type ReactNode, use } from "react";
import { useBots, useI18n, useRooms } from "../app/context";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { useBotCard } from "./BotCard";
import {
  AvatarsAsleep,
  BotAvatar,
  RoomAvatar,
  type RoomAvatarMember,
  roomAvatarMembers,
} from "./avatar/BotAvatar";

/** The side of a mention's face, in px: as small as an event line's, so it sits in a line of text. */
const MENTION_FACE = 16;

const chip =
  "mx-px inline-flex items-center gap-1 rounded-pill py-0.5 ps-0.5 pe-1.5 align-middle leading-none font-semibold";

/**
 * A bot's mention where it stands in text: its still face and `@` and the
 * name, on a tint of its color. It carries its own fill and text color, which
 * keep the name readable inside any bubble and in the composer.
 */
export function MentionChip({
  avatar,
  seed,
  name,
  className,
}: {
  avatar: Avatar;
  seed: BotId;
  name: string;
  className?: string;
}) {
  const asleep = use(AvatarsAsleep);
  return (
    <span
      className={cn(
        tintOf(avatar),
        chip,
        "bg-(--tint-bubble) text-bubble-bot-foreground",
        className,
      )}
    >
      <BotAvatar
        avatar={avatar}
        seed={seed}
        state={asleep ? "offline" : "idle"}
        size={MENTION_FACE}
        still
      />
      {/* The text stands in the chip itself, not in an element of its own: a flex item is a
          block, which a browser copies or drags with a line break on either side of it. */}
      {`@${name}`}
    </span>
  );
}

/**
 * A room's mention where it stands in text: its mark, two of its members, and
 * `@` and its name, on a neutral fill, since a room has no color of its own.
 */
export function RoomMentionChip({
  members,
  name,
  className,
}: {
  members: ReadonlyArray<RoomAvatarMember>;
  name: string;
  className?: string;
}) {
  return (
    <span className={cn(chip, "bg-muted text-foreground", className)}>
      <RoomAvatar members={members} size={MENTION_FACE} />
      {`@${name}`}
    </span>
  );
}

/**
 * Opens what a mention in a message names: a bot's conversation, or a room.
 * Where it is null, as in the gallery's still frames, a mention opens nothing.
 */
export const OpenMention = createContext<((named: ConversationMention) => void) | null>(null);

/** A chip that opens what it names, when something can open it, and a bot's card (`useBotCard`). */
function Opens({
  named,
  name,
  card = { hover: {}, focus: {} },
  children,
}: {
  named: ConversationMention;
  name: string;
  card?: ReturnType<typeof useBotCard>;
  children: ReactNode;
}) {
  const open = use(OpenMention);
  const { t } = useI18n();
  if (open === null) return <span {...card.hover}>{children}</span>;
  return (
    <button
      {...card.hover}
      {...card.focus}
      type="button"
      aria-label={t("mention.open", { name })}
      onClick={() => open(named)}
      className="cursor-pointer rounded-pill align-middle hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </button>
  );
}

/**
 * A mention in a message's text: a bot's or a room's as its chip, which opens
 * that bot's conversation or that room; or, for `@everyone` and one deleted
 * since, the name in the text's own color, set apart by weight.
 */
export function TextMention({ name, of }: { name: string; of: ConversationMention | null }) {
  const bots = useBots();
  const rooms = useRooms();
  const plain = <span className="font-semibold">@{name}</span>;
  if (of === null) return plain;
  if (of._tag === "bot") {
    const bot = bots.get(of.botId);
    if (bot === undefined) return plain;
    return <BotMention named={of} bot={bot} name={name} />;
  }
  const room = rooms.get(of.roomId);
  if (room === undefined) return plain;
  return (
    <Opens named={of} name={room.name}>
      <RoomMentionChip members={roomAvatarMembers(room, bots)} name={name} />
    </Opens>
  );
}

/** A bot's mention in a message: its chip, which opens its conversation and, under a resting pointer, its card. */
function BotMention({ named, bot, name }: { named: ConversationMention; bot: Bot; name: string }) {
  const card = useBotCard(bot.id);
  return (
    <Opens named={named} name={bot.profile.name} card={card}>
      <MentionChip avatar={bot.profile.avatar} seed={bot.id} name={name} />
    </Opens>
  );
}
