// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import type { I18n } from "../i18n/i18n";

/** What formatting a moment needs: the language, the operator's time zone and the current time. */
export interface TimeContext {
  readonly i18n: I18n;
  readonly timeZone: string;
  readonly now: DateTime.Utc;
}

const DAY = 86_400_000;

/** Days from `at` to now, counted in calendar days of the time zone. */
function calendarDaysAgo(at: DateTime.Utc, { now, timeZone }: TimeContext): number {
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

/** A narrow no-break space, which Intl itself puts between "8:47" and "AM" in some runtimes. */
const UNBREAKABLE = "\u202F";

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

const format = (at: DateTime.Utc, ctx: TimeContext, options: Intl.DateTimeFormatOptions) =>
  formatMoment(
    new Intl.DateTimeFormat(ctx.i18n.locale, { timeZone: ctx.timeZone, ...options }),
    DateTime.toEpochMillis(at),
  );

export const clockTime = (at: DateTime.Utc, ctx: TimeContext) =>
  format(at, ctx, { timeStyle: "short" });

/** When something last happened, as short as it can be: a roster row's time. */
export function activityTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = calendarDaysAgo(at, ctx);
  if (days <= 0) return clockTime(at, ctx);
  if (days === 1) return ctx.i18n.t("time.yesterday");
  if (days < 7) return format(at, ctx, { weekday: "long" });
  const sameYear =
    format(at, ctx, { year: "numeric" }) === format(ctx.now, ctx, { year: "numeric" });
  return format(at, ctx, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/** When something will happen: "8:47 AM", "Tomorrow at 8:47 AM", "Monday at 8:47 AM". */
export function upcomingTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = -calendarDaysAgo(at, ctx);
  const time = clockTime(at, ctx);
  if (days <= 0) return time;
  if (days === 1) return ctx.i18n.t("time.tomorrowAt", { time });
  if (days < 7)
    return ctx.i18n.t("time.dayAt", { day: format(at, ctx, { weekday: "long" }), time });
  return fullTime(at, ctx);
}

/**
 * A moment inside a sentence, past or future: "at 8:47 AM", "yesterday at 4:12
 * PM", "tomorrow at 8:47 AM", "Monday at 8:47 AM", "on Nov 13, 2026, 4:12 PM".
 * The standalone forms above start a line; this one follows a word.
 */
export function timeInSentence(at: DateTime.Utc, ctx: TimeContext): string {
  const days = calendarDaysAgo(at, ctx);
  const time = clockTime(at, ctx);
  const { t } = ctx.i18n;
  if (days === 0) return t("time.inSentence.today", { time });
  if (days === 1) return t("time.inSentence.yesterday", { time });
  if (days === -1) return t("time.inSentence.tomorrow", { time });
  if (Math.abs(days) < 7)
    return t("time.inSentence.day", { day: format(at, ctx, { weekday: "long" }), time });
  return t("time.inSentence.date", { date: fullTime(at, ctx) });
}

/** A moment in full, for when the day matters whatever today is: "Nov 23, 2026, 8:47 AM". */
export const fullTime = (at: DateTime.Utc, ctx: TimeContext) =>
  format(at, ctx, { dateStyle: "medium", timeStyle: "short" });

/** The time shown between groups of messages. */
export function dividerTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = calendarDaysAgo(at, ctx);
  const time = clockTime(at, ctx);
  if (days <= 0) return time;
  if (days === 1) return ctx.i18n.t("time.yesterdayAt", { time });
  if (days < 7)
    return ctx.i18n.t("time.dayAt", { day: format(at, ctx, { weekday: "long" }), time });
  return fullTime(at, ctx);
}

/** A length of time in its two largest units, narrow: "40s", "2m", "1h 5m". */
export function shortDuration(ms: number, i18n: I18n): string {
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

const unit = (i18n: I18n, name: string, n: number) =>
  new Intl.NumberFormat(i18n.locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
    n,
  );

export const millisBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from);
