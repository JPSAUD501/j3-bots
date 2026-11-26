// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which avatars move. Each avatar steps itself on the UI thread (a Reanimated
 * frame callback), and this decides, on the JS thread, whose callback runs:
 *
 * - none while the app is not in the foreground;
 * - none that is off screen, under reduced motion, still or stalled: those
 *   say they do not want to move;
 * - at most `MAX_MOVING` at once: what is `urgent` first, then the largest;
 *   the others hold their still form until one stops.
 */
import { AppState, type NativeEventSubscription } from "react-native";

/** The most avatars that move at once. */
const MAX_MOVING = 24;

/** One avatar as the scheduler sees it. */
export interface Mover {
  /** In px. */
  readonly size: number;
  /** Starts or stops its frame callback; stopped, it draws its still form. */
  readonly run: (on: boolean) => void;
  /**
   * It is something happening, not something idling, as a bot's little ones
   * are: under the cap it moves before the avatars, whatever its size.
   */
  readonly urgent?: boolean;
}

interface Entry {
  readonly mover: Mover;
  wants: boolean;
  running: boolean;
  readonly order: number;
}

const entries = new Set<Entry>();
let order = 0;
let foreground = AppState.currentState !== "background";
let subscription: NativeEventSubscription | null = null;
let pending = false;

function reschedule() {
  pending = false;
  const chosen = new Set(
    [...entries]
      .filter((entry) => entry.wants && foreground)
      .sort(
        (a, b) =>
          Number(b.mover.urgent === true) - Number(a.mover.urgent === true) ||
          b.mover.size - a.mover.size ||
          a.order - b.order,
      )
      .slice(0, MAX_MOVING),
  );
  for (const entry of entries) {
    const on = chosen.has(entry);
    if (on === entry.running) continue;
    entry.running = on;
    entry.mover.run(on);
  }
}

/** Decides once, after every change made in the same tick. */
function soon() {
  if (pending) return;
  pending = true;
  queueMicrotask(reschedule);
}

/**
 * Adds `mover`, not running until it wants to move. Returns how to say
 * whether it wants to, and how to take it out again.
 */
export function join(mover: Mover): {
  readonly want: (on: boolean) => void;
  readonly leave: () => void;
} {
  if (entries.size === 0) {
    foreground = AppState.currentState !== "background";
    subscription = AppState.addEventListener("change", (status) => {
      foreground = status === "active";
      soon();
    });
  }
  const entry: Entry = { mover, wants: false, running: false, order: order++ };
  entries.add(entry);
  return {
    want: (on) => {
      if (entry.wants === on) return;
      entry.wants = on;
      soon();
    },
    leave: () => {
      if (!entries.delete(entry)) return;
      if (entry.running) entry.mover.run(false);
      if (entries.size === 0) {
        subscription?.remove();
        subscription = null;
      } else soon();
    },
  };
}
