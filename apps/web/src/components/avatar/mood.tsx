// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EntryPreview } from "@j3-bots/contracts";
import { useAsleep, useAvatarMood } from "@j3-bots/client-runtime/react";
import { createContext, type ReactNode, type Ref, useContext } from "react";
import { type AvatarHandle, BotAvatar } from "./BotAvatar";

const Offline = createContext(false);

/** Tells the avatars below it whether this client can see the server (`useAsleep`). */
export function AvatarConnection({
  connected,
  children,
}: {
  readonly connected: boolean;
  readonly children: ReactNode;
}) {
  return <Offline value={useAsleep(connected)}>{children}</Offline>;
}

/** A bot's avatar as it is now: its state, what is unread and what is arriving, live. */
export function LiveBotAvatar({
  bot,
  unread = false,
  lastEntry = null,
  size,
  label,
  ref,
}: {
  readonly bot: Bot;
  readonly unread?: boolean;
  readonly lastEntry?: EntryPreview | null;
  readonly size: number;
  readonly label?: string;
  readonly ref?: Ref<AvatarHandle>;
}) {
  const offline = useContext(Offline);
  const mood = useAvatarMood(bot, { unread, lastEntry, offline });
  return (
    <BotAvatar
      avatar={bot.profile.avatar}
      seed={bot.id}
      state={mood.state}
      stalled={mood.stalled}
      size={size}
      {...(label === undefined ? {} : { label })}
      {...(ref === undefined ? {} : { ref })}
    />
  );
}
