// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";

interface Clock {
  readonly now: DateTime.Utc;
  /** The device's time zone. */
  readonly timeZone: string;
}

const ClockContext = createContext<Clock>({
  now: DateTime.makeUnsafe(0),
  timeZone: "UTC",
});

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The current time for relative labels, updated every half minute. `now` pins it. */
export function ClockProvider({ now, children }: { now?: DateTime.Utc; children: ReactNode }) {
  const [ticking, setTicking] = useState(() => DateTime.makeUnsafe(Date.now()));
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setTicking(DateTime.makeUnsafe(Date.now())), 30_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const clock = useMemo(
    () => ({ now: now ?? ticking, timeZone: systemTimeZone() }),
    [now, ticking],
  );
  return <ClockContext value={clock}>{children}</ClockContext>;
}

const OperatorTimeZoneContext = createContext<string | null>(null);

/**
 * The zone, if this browser knows it. The server checks a saved zone against
 * its own time zone data, which can be newer than an older browser's.
 */
function knownTimeZone(timeZone: string): string | null {
  try {
    // A zone it does not know throws a RangeError.
    new Intl.DateTimeFormat(undefined, { timeZone }).format(0);
    return timeZone;
  } catch {
    return null;
  }
}

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
