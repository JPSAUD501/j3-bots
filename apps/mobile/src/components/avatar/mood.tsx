// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAsleep, useAvatarMood, useConnection } from "@j3-bots/client-runtime/react";
import type { Bot, EntryPreview } from "@j3-bots/contracts";
import { createContext, type ReactNode, type Ref, useContext } from "react";
import { type AvatarGround, type AvatarHandle, BotAvatar } from "./BotAvatar.tsx";

const Offline = createContext(false);

/** Whether the app has lost sight of the server long enough that what it shows may be out of date. */
export const useOffline = (): boolean => useContext(Offline);

/**
 * Tells the avatars below it whether the app can see the server
 * (`useAsleep`). In the background nothing is on screen, so that counts as
 * connected: the app connects again on its return.
 */
export function AvatarConnection({ children }: { readonly children: ReactNode }) {
  const connection = useConnection()._tag;
  const connected = connection === "connected" || connection === "background";
  return <Offline value={useAsleep(connected)}>{children}</Offline>;
}

/** A bot's avatar as it is now: its state, what is unread and what is arriving, live. */
export function LiveBotAvatar({
  bot,
  unread = false,
  lastEntry = null,
  size,
  ground,
  label,
  ref,
}: {
  readonly bot: Bot;
  readonly unread?: boolean;
  readonly lastEntry?: EntryPreview | null;
  readonly size: number;
  readonly ground?: AvatarGround;
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
      {...(ground === undefined ? {} : { ground })}
      {...(label === undefined ? {} : { label })}
      {...(ref === undefined ? {} : { ref })}
    />
  );
}
