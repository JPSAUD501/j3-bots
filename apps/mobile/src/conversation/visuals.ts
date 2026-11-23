// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId } from "@j3-bots/contracts";
import { createContext } from "react";

/**
 * What the visuals of one open conversation share: the height each last
 * reported, so a visual the list unmounts as it scrolls away comes back at its
 * own height and nothing around it moves; the visuals a page of theirs made
 * fail; and whether the list is moving, which a visual waits out before it
 * loads its page. Make one per conversation (`conversationVisuals`), tell it
 * of every scroll, and end it when the conversation closes.
 */
export interface ConversationVisuals {
  readonly heights: Map<EntryId, number>;
  /**
   * The visuals that were on screen when a page took down the renderer they
   * share, which stay failed while the conversation is open: loaded again,
   * the page that did it would take the others down with it once more, and
   * Android does not say which page it was.
   */
  readonly failed: Set<EntryId>;
  /** Tells the visuals the list moved; they count it still once it has not for `STILL_MS`. */
  readonly scrolled: () => void;
  readonly moving: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /** Stops waiting for the list to be still: the conversation closed. */
  readonly end: () => void;
}

/** How long the list must not move to count as still. */
const STILL_MS = 120;

export function conversationVisuals(): ConversationVisuals {
  const listeners = new Set<() => void>();
  let moving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: boolean) => {
    if (next === moving) return;
    moving = next;
    for (const listener of listeners) listener();
  };
  return {
    heights: new Map(),
    failed: new Set(),
    scrolled: () => {
      set(true);
      clearTimeout(timer);
      timer = setTimeout(() => set(false), STILL_MS);
    },
    moving: () => moving,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    end: () => {
      clearTimeout(timer);
      set(false);
    },
  };
}

export const ConversationVisualsContext = createContext<ConversationVisuals | null>(null);
