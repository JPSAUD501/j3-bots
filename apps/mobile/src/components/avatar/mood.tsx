// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAsleep, useAvatarMood, useConnection } from "@j3-bots/client-runtime/react";
import type { Bot, EntryPreview } from "@j3-bots/contracts";
import { type ReactNode, type Ref, useContext } from "react";
import { type AvatarGround, type AvatarHandle, AvatarsAsleep, BotAvatar } from "./BotAvatar.tsx";
import { PrimaryMark } from "./PrimaryMark.tsx";

/** Whether the app has lost sight of the server long enough that what it shows may be out of date. */
export const useOffline = (): boolean => useContext(AvatarsAsleep);

/**
 * Tells the avatars below it whether the app can see the server
 * (`useAsleep`). In the background nothing is on screen, so that counts as
 * connected: the app connects again on its return.
 */
export function AvatarConnection({ children }: { readonly children: ReactNode }) {
  const connection = useConnection()._tag;
  const connected = connection === "connected" || connection === "background";
  return <AvatarsAsleep value={useAsleep(connected)}>{children}</AvatarsAsleep>;
}

/**
 * A bot's avatar as it is now: its state, what is unread and what is
 * arriving, live. Where the bot is named by its avatar (a roster row, a
 * pinned bot, the conversation header, the details) `markPrimary` adds the
 * primary bot's mark; small inline avatars go without.
 */
export function LiveBotAvatar({
  bot,
  unread = false,
  lastEntry = null,
  size,
  ground,
  label,
  markPrimary = false,
  ref,
}: {
  readonly bot: Bot;
  readonly unread?: boolean;
  readonly lastEntry?: EntryPreview | null;
  readonly size: number;
  readonly ground?: AvatarGround;
  readonly label?: string;
  readonly markPrimary?: boolean;
  readonly ref?: Ref<AvatarHandle>;
}) {
  const offline = useContext(AvatarsAsleep);
  const mood = useAvatarMood(bot, { unread, lastEntry, offline });
  const avatar = (
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
  return markPrimary && bot.primary ? (
    <PrimaryMark size={size} ground={ground}>
      {avatar}
    </PrimaryMark>
  ) : (
    avatar
  );
}
