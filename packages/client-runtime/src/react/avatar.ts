// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- React hooks, which run on the platform's timers, outside any Effect program.
// @effect-diagnostics globalDate:off -- the speaking window ends at a wall-clock time the message carries.
import type { Bot, EntryPreview } from "@j3-bots/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { type AvatarMood, avatarMood, speakingUntil } from "../presentation/avatar.ts";

/** How long the connection may be gone before the bots show asleep, in ms: a reconnect within it shows nothing. */
const ASLEEP_AFTER = 3000;

/**
 * Whether the bots show asleep: once this client has been disconnected for a
 * few seconds, since what it last heard of them may no longer be true.
 */
export function useAsleep(connected: boolean): boolean {
  const [asleep, setAsleep] = useState(false);
  // A connection back wakes them at once, in the render that sees it.
  const [seen, setSeen] = useState(connected);
  if (seen !== connected) {
    setSeen(connected);
    if (connected) setAsleep(false);
  }
  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setAsleep(true), ASLEEP_AFTER);
    return () => clearTimeout(timer);
  }, [connected]);
  return asleep;
}

/** Whether `until`, an epoch ms or null, is still ahead, turning false when it passes. */
function useUntil(until: number | null): boolean {
  const subscribe = useCallback(
    (passed: () => void) => {
      if (until === null) return () => {};
      const timer = setTimeout(passed, Math.max(0, until - Date.now()));
      return () => clearTimeout(timer);
    },
    [until],
  );
  const ahead = () => until !== null && Date.now() < until;
  return useSyncExternalStore(subscribe, ahead, ahead);
}

/**
 * What `bot`'s avatar shows now: its own state, whether it said something the
 * operator has not read, whether its last message is still arriving, and
 * whether this client can see the server at all (`useAsleep`).
 */
export function useAvatarMood(
  bot: Bot,
  options: {
    readonly unread: boolean;
    readonly lastEntry: EntryPreview | null;
    readonly offline: boolean;
  },
): AvatarMood {
  const speaking = useUntil(speakingUntil(options.lastEntry, bot.id));
  return avatarMood(bot.state, { unread: options.unread, speaking, offline: options.offline });
}
