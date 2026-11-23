// SPDX-License-Identifier: AGPL-3.0-or-later
import { AppState, type NativeEventSubscription } from "react-native";
import { useSyncExternalStore } from "react";

const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

/**
 * One clock for everything that counts up by the second, so they tick
 * together: the time it last read, kept while anything listens and the app
 * is in front. A clock nobody can see does not tick.
 */
const seconds = {
  now: wholeSecond(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
  subscription: null as NativeEventSubscription | null,
};

const read = () => {
  seconds.now = wholeSecond();
  for (const listener of seconds.listeners) listener();
};

/**
 * Ticks while the app may be in front: also while its state is still unknown,
 * as it is for a moment at launch, so a clock read then does not stand still.
 */
const follow = (state: typeof AppState.currentState) => {
  if (seconds.timer !== null) clearInterval(seconds.timer);
  seconds.timer = null;
  if (state === "background" || state === "inactive") return;
  seconds.timer = setInterval(read, 1000);
  read();
};

function subscribe(listener: () => void): () => void {
  if (seconds.listeners.size === 0) {
    seconds.subscription = AppState.addEventListener("change", follow);
    follow(AppState.currentState);
  }
  seconds.listeners.add(listener);
  return () => {
    seconds.listeners.delete(listener);
    if (seconds.listeners.size > 0) return;
    follow("background");
    seconds.subscription?.remove();
    seconds.subscription = null;
  };
}

const current = () => seconds.now;
const still = () => () => {};

/** The time now, in epoch ms, kept to the second while `running` and the app is in front. */
export function useSeconds(running: boolean): number {
  return useSyncExternalStore(running ? subscribe : still, current, current);
}
