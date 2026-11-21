// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";

/**
 * What formatting a moment needs: the reader's language, the operator's time
 * zone and the current time. Of the language only its locale counts here; the
 * sentences around a moment are the client's.
 */
export interface LocalTime {
  readonly i18n: { readonly locale: string };
  readonly timeZone: string;
  readonly now: DateTime.Utc;
}

const DAY = 86_400_000;

/** Days from `at` to now, counted in calendar days of the time zone. */
export function calendarDaysAgo(
  at: DateTime.Utc,
  { now, timeZone }: Pick<LocalTime, "now" | "timeZone">,
): number {
  const dayNumber = (moment: DateTime.Utc) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(DateTime.toEpochMillis(moment));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
  };
  return dayNumber(now) - dayNumber(at);
}

/** The parts of a time of day: "8", ":", "47", " ", "AM". */
const TIME_OF_DAY: ReadonlySet<Intl.DateTimeFormatPartTypes> = new Set([
  "hour",
  "minute",
  "second",
  "fractionalSecond",
  "dayPeriod",
]);

/**
 * A no-break space. Some runtimes put a narrow one (U+202F) between "8:47" and
 * "AM", but the interface font sets it so thin at small sizes that "2:31 PM"
 * reads as one word; a full-width one keeps the gap and still never breaks.
 */
const UNBREAKABLE = "\u00A0";

/**
 * A moment as `formatter` writes it, with every time of day in one piece: the
 * spaces inside "8:47 AM" or "8:47 p. m." never break, so a line never ends
 * between the minutes and the period. Spaces around a date stay breakable.
 * Runtimes differ on which space they put there, so this sets it rather than
 * trusting it.
 */
export function formatMoment(formatter: Intl.DateTimeFormat, epochMillis: number): string {
  const parts = formatter.formatToParts(epochMillis);
  const timeOfDay = (part: Intl.DateTimeFormatPart | undefined) =>
    part !== undefined && TIME_OF_DAY.has(part.type);
  return parts
    .map((part, index) =>
      part.type === "dayPeriod" ||
      (part.type === "literal" && timeOfDay(parts[index - 1]) && timeOfDay(parts[index + 1]))
        ? part.value.replace(/\s/g, UNBREAKABLE)
        : part.value,
    )
    .join("");
}

/** A moment in the reader's language and time zone, with the given formatter options. */
export const formatAt = (at: DateTime.Utc, ctx: LocalTime, options: Intl.DateTimeFormatOptions) =>
  formatMoment(
    new Intl.DateTimeFormat(ctx.i18n.locale, { timeZone: ctx.timeZone, ...options }),
    DateTime.toEpochMillis(at),
  );

/** A time of day alone: "8:47 AM". */
export const clockTime = (at: DateTime.Utc, ctx: LocalTime) =>
  formatAt(at, ctx, { timeStyle: "short" });

/** A moment in full, for when the day matters whatever today is: "Nov 23, 2026, 8:47 AM". */
export const fullTime = (at: DateTime.Utc, ctx: LocalTime) =>
  formatAt(at, ctx, { dateStyle: "medium", timeStyle: "short" });

/** A length of time in its two largest units, narrow: "40s", "2m", "1h 5m". */
export function shortDuration(ms: number, i18n: { readonly locale: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const units = [
    ["day", Math.floor(total / 86_400)],
    ["hour", Math.floor(total / 3600) % 24],
    ["minute", Math.floor(total / 60) % 60],
    ["second", total % 60],
  ] as const;
  const first = units.findIndex(([, n]) => n > 0);
  if (first === -1) return unit(i18n, "second", 0);
  return units
    .slice(first, first + 2)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => unit(i18n, name, n))
    .join(" ");
}

const unit = (i18n: { readonly locale: string }, name: string, n: number) =>
  new Intl.NumberFormat(i18n.locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
    n,
  );

export const millisBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from);

/**
 * The zone as this device names it, in its canonical case
 * ("america/sao_paulo" is "America/Sao_Paulo"); null if the device does not
 * know it. The server checks a saved zone against its own time zone data,
 * which can be newer than a device's, so a client shows times in a zone it
 * does not know in its own instead.
 */
export function knownTimeZone(timeZone: string): string | null {
  try {
    // A zone it does not know throws a RangeError.
    return new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
