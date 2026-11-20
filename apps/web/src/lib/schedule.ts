// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineTrigger } from "@j3-bots/contracts";
import { fullTime, type TimeContext } from "./time";

/**
 * A routine's trigger written out, as the operator would say it: "Weekdays at
 * 8:47", not `47 8 * * 1-5`. A single run is given in the operator's time
 * zone; a schedule's times are in its own. Returns null for a schedule that
 * has no plain sentence; the interface then shows the expression itself.
 */
export function scheduleInWords(trigger: RoutineTrigger, ctx: TimeContext): string | null {
  const { i18n } = ctx;
  switch (trigger._tag) {
    case "webhook":
      return i18n.t("schedule.webhook");
    case "once":
      return i18n.t("schedule.once", { when: fullTime(trigger.at, ctx) });
    case "schedule":
      return cronInWords(trigger.cron, ctx);
  }
}

function cronInWords(cron: string, { i18n }: TimeContext): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  if (month !== "*") return null;

  const every = /^\*\/(\d+)$/.exec(minute);
  if (every?.[1] !== undefined && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return i18n.plural("schedule.everyMinutes", Number(every[1]));
  }

  const m = number(minute, 59);
  if (m === null) return null;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return i18n.t("schedule.hourly", { minute: String(m).padStart(2, "0") });
  }

  const h = number(hour, 23);
  if (h === null) return null;
  const time = new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short", timeZone: "UTC" }).format(
    Date.UTC(2000, 0, 1, h, m),
  );

  if (dayOfMonth !== "*") {
    const day = number(dayOfMonth, 31);
    return day === null || day === 0 || dayOfWeek !== "*"
      ? null
      : i18n.t("schedule.monthly", { day, time });
  }
  if (dayOfWeek === "*") return i18n.t("schedule.daily", { time });

  const days = weekdays(dayOfWeek);
  if (days === null) return null;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return i18n.t("schedule.weekdays", { time });
  if (key === "0,6") return i18n.t("schedule.weekends", { time });
  const names = days.map((d) =>
    new Intl.DateTimeFormat(i18n.locale, { weekday: "long", timeZone: "UTC" }).format(
      // 2000-01-02 was a Sunday.
      Date.UTC(2000, 0, 2 + d),
    ),
  );
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names);
  return i18n.t("schedule.onDays", { days: list, time });
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
