// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EntryPreview } from "@j3-bots/contracts";
import { useAsleep, useAvatarMood } from "@j3-bots/client-runtime/react";
import { type ReactNode, type Ref, use } from "react";
import { type AvatarHandle, AvatarsAsleep, BotAvatar } from "./BotAvatar";

/** Whether this client has lost sight of the server long enough that what it shows may be out of date. */
export const useOffline = (): boolean => use(AvatarsAsleep);

/** Tells the avatars below it whether this client can see the server (`useAsleep`). */
export function AvatarConnection({
  connected,
  children,
}: {
  readonly connected: boolean;
  readonly children: ReactNode;
}) {
  return <AvatarsAsleep value={useAsleep(connected)}>{children}</AvatarsAsleep>;
}

/** A bot's avatar as it is now: its state, what is unread and what is arriving, live. */
export function LiveBotAvatar({
  bot,
  unread = false,
  lastEntry = null,
  size,
  label,
  entrance = false,
  cutout = false,
  ref,
}: {
  readonly bot: Bot;
  readonly unread?: boolean;
  readonly lastEntry?: EntryPreview | null;
  readonly size: number;
  readonly label?: string;
  /** Comes in from above as it first shows (`BotAvatar`). */
  readonly entrance?: boolean;
  /** Stands clear of what it overlaps, in a band of what it sits on (`BotAvatar`). */
  readonly cutout?: boolean;
  readonly ref?: Ref<AvatarHandle>;
}) {
  const offline = use(AvatarsAsleep);
  const mood = useAvatarMood(bot, { unread, lastEntry, offline });
  return (
    <BotAvatar
      avatar={bot.profile.avatar}
      seed={bot.id}
      state={mood.state}
      stalled={mood.stalled}
      size={size}
      entrance={entrance}
      cutout={cutout}
      {...(label === undefined ? {} : { label })}
      {...(ref === undefined ? {} : { ref })}
    />
  );
}
