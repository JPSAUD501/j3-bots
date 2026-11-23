// SPDX-License-Identifier: AGPL-3.0-or-later
import { knownTimeZone } from "@j3-bots/client-runtime/presentation";
import * as DateTime from "effect/DateTime";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { systemTimeZone } from "../lib/timeZone";

interface Clock {
  readonly now: DateTime.Utc;
  /** The device's time zone. */
  readonly timeZone: string;
  /** `now` stands at a time given, as in the gallery and in tests: nothing ticks. */
  readonly pinned: boolean;
}

const ClockContext = createContext<Clock>({
  now: DateTime.makeUnsafe(0),
  timeZone: "UTC",
  pinned: false,
});

/** The current time for relative labels, updated every half minute. `now` pins it. */
export function ClockProvider({ now, children }: { now?: DateTime.Utc; children: ReactNode }) {
  const [ticking, setTicking] = useState(() => DateTime.makeUnsafe(Date.now()));
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setTicking(DateTime.makeUnsafe(Date.now())), 30_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const clock = useMemo(
    () => ({ now: now ?? ticking, timeZone: systemTimeZone(), pinned: now !== undefined }),
    [now, ticking],
  );
  return <ClockContext value={clock}>{children}</ClockContext>;
}

const OperatorTimeZoneContext = createContext<string | null>(null);

/**
 * Every time under it in the operator's time zone, as saved in Settings;
 * `null`, before the settings are read, keeps the device's, as does a zone
 * this browser does not know.
 */
export function OperatorTimeZone({
  timeZone,
  children,
}: {
  timeZone: string | null;
  children: ReactNode;
}) {
  const known = useMemo(() => (timeZone === null ? null : knownTimeZone(timeZone)), [timeZone]);
  return <OperatorTimeZoneContext value={known}>{children}</OperatorTimeZoneContext>;
}

/** The time now, and the time zone to show every time in. */
export function useClock(): { readonly now: DateTime.Utc; readonly timeZone: string } {
  const clock = use(ClockContext);
  return { now: clock.now, timeZone: use(OperatorTimeZoneContext) ?? clock.timeZone };
}

/**
 * One clock for everything that counts up by the second, so they tick
 * together: the time it last read, kept while anything listens and the page
 * is shown. A clock nobody can see does not tick.
 */
const seconds = {
  now: Math.floor(Date.now() / 1000) * 1000,
  listeners: new Set<() => void>(),
  timer: undefined as number | undefined,
};

const readSecond = () => {
  seconds.now = Math.floor(Date.now() / 1000) * 1000;
  for (const listener of seconds.listeners) listener();
};

const followVisibility = () => {
  window.clearInterval(seconds.timer);
  seconds.timer = document.hidden ? undefined : window.setInterval(readSecond, 1000);
  if (!document.hidden) readSecond();
};

function subscribeSeconds(listener: () => void): () => void {
  if (seconds.listeners.size === 0) {
    document.addEventListener("visibilitychange", followVisibility);
    followVisibility();
  }
  seconds.listeners.add(listener);
  return () => {
    seconds.listeners.delete(listener);
    if (seconds.listeners.size > 0) return;
    window.clearInterval(seconds.timer);
    seconds.timer = undefined;
    document.removeEventListener("visibilitychange", followVisibility);
  };
}

const currentSecond = () => seconds.now;
const never = () => () => {};

/**
 * The time now, in epoch ms, kept to the second while `running` and the page
 * is shown, for a clock that counts up. A pinned clock stands at its time.
 */
export function useSeconds(running: boolean): number {
  const clock = use(ClockContext);
  const pinned = DateTime.toEpochMillis(clock.now);
  const live = running && !clock.pinned;
  const standing = () => pinned;
  return useSyncExternalStore(
    live ? subscribeSeconds : never,
    live ? currentSecond : standing,
    standing,
  );
}
