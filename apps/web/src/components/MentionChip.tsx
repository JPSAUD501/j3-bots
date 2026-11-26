// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, BotId } from "@j3-bots/contracts";
import { use } from "react";
import { useBots } from "../app/context";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { AvatarsAsleep, BotAvatar } from "./avatar/BotAvatar";

/** The side of a mention's face, in px: as small as an event line's, so it sits in a line of text. */
const MENTION_FACE = 16;

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
        "mx-px inline-flex items-center gap-1 rounded-pill bg-(--tint-bubble) py-0.5 ps-0.5 pe-1.5 align-middle leading-none font-semibold text-bubble-bot-foreground",
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
 * A mention in a message's text: a bot's as its chip, or, for `@everyone` and
 * a bot deleted since, the name in the text's own color, set apart by weight.
 */
export function TextMention({ name, botId }: { name: string; botId: BotId | null }) {
  const bots = useBots();
  const bot = botId === null ? undefined : bots.get(botId);
  if (bot === undefined) return <span className="font-semibold">@{name}</span>;
  return <MentionChip avatar={bot.profile.avatar} seed={bot.id} name={name} />;
}
