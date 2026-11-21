// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as DateTime from "effect/DateTime";
import {
  calendarDaysAgo,
  clockTime,
  formatAt,
  fullTime,
  type LocalTime,
} from "@j3-bots/client-runtime/presentation";
import type { I18n } from "../i18n/i18n";

/** What formatting a moment needs: the language, the operator's time zone and the current time. */
export interface TimeContext extends LocalTime {
  readonly i18n: I18n;
}

/** When something last happened, as short as it can be: a roster row's time. */
export function activityTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = calendarDaysAgo(at, ctx);
  if (days <= 0) return clockTime(at, ctx);
  if (days === 1) return ctx.i18n.t("time.yesterday");
  if (days < 7) return formatAt(at, ctx, { weekday: "long" });
  const sameYear =
    formatAt(at, ctx, { year: "numeric" }) === formatAt(ctx.now, ctx, { year: "numeric" });
  return formatAt(at, ctx, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/** When something will happen: "8:47 AM", "Tomorrow at 8:47 AM", "Monday at 8:47 AM". */
export function upcomingTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = -calendarDaysAgo(at, ctx);
  const time = clockTime(at, ctx);
  if (days <= 0) return time;
  if (days === 1) return ctx.i18n.t("time.tomorrowAt", { time });
  if (days < 7)
    return ctx.i18n.t("time.dayAt", { day: formatAt(at, ctx, { weekday: "long" }), time });
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
    return t("time.inSentence.day", { day: formatAt(at, ctx, { weekday: "long" }), time });
  return t("time.inSentence.date", { date: fullTime(at, ctx) });
}

/** The time shown between groups of messages. */
export function dividerTime(at: DateTime.Utc, ctx: TimeContext): string {
  const days = calendarDaysAgo(at, ctx);
  const time = clockTime(at, ctx);
  if (days <= 0) return time;
  if (days === 1) return ctx.i18n.t("time.yesterdayAt", { time });
  if (days < 7)
    return ctx.i18n.t("time.dayAt", { day: formatAt(at, ctx, { weekday: "long" }), time });
  return fullTime(at, ctx);
}
