// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, type Spring, springs } from "@j3-bots/design-tokens";
import { type ComponentProps, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";
import Animated, {
  type EntryExitAnimationFunction,
  FadeInDown,
  withSpring,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";

/** Whether the platform asks for reduced motion, following the setting as it changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (current) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

interface Ticker {
  count: number;
  readonly listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

/** One timer per interval, shared by everything that steps at it, so they step together. */
const tickers = new Map<number, Ticker>();

const tickerFor = (interval: number): Ticker => {
  const existing = tickers.get(interval);
  if (existing !== undefined) return existing;
  const ticker: Ticker = { count: 0, listeners: new Set(), timer: null };
  tickers.set(interval, ticker);
  return ticker;
};

const subscribeTo = (interval: number) => (listener: () => void) => {
  const ticker = tickerFor(interval);
  ticker.listeners.add(listener);
  ticker.timer ??= setInterval(() => {
    ticker.count += 1;
    for (const notify of ticker.listeners) notify();
  }, interval);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer !== null) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
};

const still = () => () => {};
const zero = () => 0;

/**
 * Which of `steps` equal steps of `period` ms a stepped motion is at, changing
 * `steps` times a period rather than every frame; 0 throughout while not
 * `running`.
 */
export function useStep(period: number, steps: number, running: boolean): number {
  const interval = period / steps;
  const [subscribe, getCount] = useMemo(
    () => (running ? [subscribeTo(interval), () => tickerFor(interval).count] : [still, zero]),
    [running, interval],
  );
  return useSyncExternalStore(subscribe, getCount) % steps;
}

/*
 * Entrances on the springs of `@j3-bots/design-tokens`. Reanimated settles
 * each at once where the system asks for reduced motion, as it does every
 * animation that names no other policy.
 */

/**
 * How something new settles into a conversation: up from a little below as
 * it fades in, on the spring given.
 */
export const settleIn = (spring: Spring) => {
  const { mass, stiffness, damping } = reanimatedSpring(spring);
  return FadeInDown.springify()
    .mass(mass)
    .stiffness(stiffness)
    .damping(damping)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 12 }] });
};

/** How a conversation opens: its entries fade up a few px into place, on the `soft` spring. */
export const openIn = () => {
  const { mass, stiffness, damping } = reanimatedSpring(springs.soft);
  return FadeInDown.springify()
    .mass(mass)
    .stiffness(stiffness)
    .damping(damping)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 6 }] });
};

/** A small mark, a check, that pops into place on the `pop` spring, after `delay` ms. */
export const popIn = (delay = 0) => {
  const { mass, stiffness, damping } = reanimatedSpring(springs.pop);
  return ZoomIn.springify().mass(mass).stiffness(stiffness).damping(damping).delay(delay);
};

const popSpring = reanimatedSpring(springs.pop);

/**
 * Something that arrives in place of nothing, such as an empty state's mark:
 * it fades in and pops up from a little smaller on `pop`, as the web's
 * `appear` does.
 */
export const appear: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.96 }] },
    animations: {
      opacity: withTiming(1, { duration: motion.state }),
      transform: [{ scale: withSpring(1, popSpring) }],
    },
  };
};

type Entering = NonNullable<ComponentProps<typeof Animated.View>["entering"]>;

/**
 * The `entering` prop of something that animates in only when it is `fresh`:
 * what was already there when a conversation opened appears in place.
 */
export const enteringWhen = (
  fresh: boolean,
  animation: Entering,
): { readonly entering?: Entering } => (fresh ? { entering: animation } : {});
