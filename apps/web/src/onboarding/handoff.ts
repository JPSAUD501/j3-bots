// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * The view-transition name the first bot's avatar travels under, from its
 * arrival into its conversation's header. The page's stylesheet sets the
 * travel's spring.
 */
export const ARRIVING = "arriving-bot";

/** How long the page waits for the conversation to show, at most, before it changes without it. */
const LANDING_WAIT = 800;

interface Landing {
  readonly botId: BotId;
  /** Whether the avatar travels; under reduced motion the page only crossfades. */
  readonly travels: boolean;
  readonly landed: () => void;
}

let landing: Landing | null = null;
const listeners = new Set<() => void>();

const settle = (next: Landing | null) => {
  landing = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Opens the first bot's conversation from its arrival in one view transition:
 * the first run gives way to the conversation as the bot's avatar travels
 * into the conversation's header, or, where `travels` is false, the two only
 * crossfade. The page keeps showing the arrival until the header is drawn, so
 * both ends of the move are known. A browser without view transitions just
 * opens the conversation.
 */
export function openArrived(botId: BotId, open: () => void, travels: boolean): void {
  if (typeof document.startViewTransition !== "function") {
    open();
    return;
  }
  // Not `Promise.withResolvers`: some browsers with view transitions predate it.
  let landed = () => {};
  const promise = new Promise<void>((resolve) => {
    landed = resolve;
  });
  settle({ botId, travels, landed });
  const transition = document.startViewTransition(() => {
    open();
    // A conversation that never shows, as one already gone, still changes the page.
    return Promise.race([
      promise,
      new Promise<void>((done) => window.setTimeout(done, LANDING_WAIT)),
    ]);
  });
  // A transition the browser skips, as for a hidden tab, still opens the conversation: only the
  // move is lost, so the reason it gives is not an error of the page's.
  transition.ready.catch(() => {});
  const done = () => settle(null);
  transition.finished.then(done, done);
}

/**
 * For the avatar in a conversation's header: the view-transition name it
 * lands under while its bot arrives from the first run, and the signal that
 * it is drawn.
 */
export function useLanding(botId: BotId | null): string | undefined {
  const now = useSyncExternalStore(
    subscribe,
    () => landing,
    () => null,
  );
  const here = now !== null && botId !== null && now.botId === botId ? now : null;
  useLayoutEffect(() => here?.landed(), [here]);
  return here?.travels === true ? ARRIVING : undefined;
}
