// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import { formatMoment, type LocalTime } from "./time.ts";

/** A time of day a schedule runs at, in the schedule's own time zone. */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

/**
 * A cron expression that a plain sentence can say, read into what that
 * sentence says: "every 15 minutes", "every hour at :47", "weekdays at 8:47".
 * Days of the week run 0-6 from Sunday.
 */
export type CronSchedule =
  | { readonly _tag: "everyMinutes"; readonly minutes: number }
  | { readonly _tag: "hourly"; readonly minute: number }
  | { readonly _tag: "everyHours"; readonly hours: number; readonly minute: number }
  | { readonly _tag: "monthly"; readonly day: number; readonly at: TimeOfDay }
  | { readonly _tag: "daily"; readonly at: TimeOfDay }
  | { readonly _tag: "weekdays"; readonly at: TimeOfDay }
  | { readonly _tag: "weekends"; readonly at: TimeOfDay }
  | { readonly _tag: "onDays"; readonly days: ReadonlyArray<number>; readonly at: TimeOfDay };

/**
 * A cron expression as a schedule a sentence can say, or null for one that
 * has no plain sentence; the interface then shows the expression itself.
 */
export function readCron(cron: string): CronSchedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  if (month !== "*") return null;

  const daily = dayOfMonth === "*" && dayOfWeek === "*";
  const everyMinutes = step(minute, 60);
  if (everyMinutes !== null && hour === "*" && daily) {
    return { _tag: "everyMinutes", minutes: everyMinutes };
  }

  const m = number(minute, 59);
  if (m === null) return null;
  if (hour === "*" && daily) return { _tag: "hourly", minute: m };
  const everyHours = step(hour, 24);
  if (everyHours !== null && daily) return { _tag: "everyHours", hours: everyHours, minute: m };

  const h = number(hour, 23);
  if (h === null) return null;
  const at = { hour: h, minute: m };

  if (dayOfMonth !== "*") {
    const day = number(dayOfMonth, 31);
    if (day === null || day === 0 || dayOfWeek !== "*") return null;
    return { _tag: "monthly", day, at };
  }
  if (dayOfWeek === "*") return { _tag: "daily", at };

  const days = weekdays(dayOfWeek);
  if (days === null) return null;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return { _tag: "weekdays", at };
  if (key === "0,6") return { _tag: "weekends", at };
  return { _tag: "onDays", days, at };
}

/**
 * The step of a `*\/N` field over a cycle of `cycle` units, when N divides the
 * cycle evenly: only then does it run at the same spacing all the way round.
 * `*\/7` minutes runs at :56 and again at :00, which "every 7 minutes" would
 * misstate.
 */
function step(field: string, cycle: number): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  if (match?.[1] === undefined) return null;
  const n = Number(match[1]);
  return n > 0 && cycle % n === 0 ? n : null;
}

function number(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

/** Sorted, distinct days 0-6 (Sunday is 0; cron's 7 is Sunday too), or null if not a plain list. */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (range?.[1] === undefined) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 7 || to > 7 || to < from) return null;
    for (let d = from; d <= to; d++) days.add(d % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * A time zone as the language names it today, such as "Western European
 * Time" (a zone's name follows its rules, which change over the years); its
 * id if this runtime does not know it.
 */
export function zoneName(timeZone: string, { i18n, now }: Pick<LocalTime, "i18n" | "now">): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(i18n.locale, {
      timeZone,
      timeZoneName: "longGeneric",
    }).formatToParts(DateTime.toEpochMillis(now));
  } catch (error) {
    // An id this runtime does not know: say it as saved.
    if (error instanceof RangeError) return timeZone;
    throw error;
  }
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/** A minute past the hour as a clock writes it: "07". */
export const minuteText = (minute: number): string => String(minute).padStart(2, "0");

/** A schedule's time of day as the language writes it: "8:47 AM". */
export const timeOfDayText = ({ hour, minute }: TimeOfDay, { i18n }: Pick<LocalTime, "i18n">) =>
  formatMoment(
    new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short", timeZone: "UTC" }),
    Date.UTC(2000, 0, 1, hour, minute),
  );

/** Days of the week, 0-6 from Sunday, as the language lists them: "Monday and Thursday". */
export function weekdayList(days: ReadonlyArray<number>, { i18n }: Pick<LocalTime, "i18n">) {
  const day = new Intl.DateTimeFormat(i18n.locale, { weekday: "long", timeZone: "UTC" });
  // 2000-01-02 was a Sunday.
  const names = days.map((d) => day.format(Date.UTC(2000, 0, 2 + d)));
  return new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names);
}
