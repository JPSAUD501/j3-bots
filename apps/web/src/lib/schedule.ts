// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineTrigger } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import {
  formatMoment,
  fullTime,
  readCron,
  type TimeOfDay,
} from "@j3-bots/client-runtime/presentation";
import type { I18n } from "../i18n/i18n";
import type { TimeContext } from "./time";

/**
 * A routine's trigger written out, as the operator would say it: "Weekdays at
 * 8:47", not `47 8 * * 1-5`. A single run is given in the operator's time
 * zone. A schedule's times are in its own, and the sentence names that zone
 * when it is not the operator's. Returns null for a schedule that has no
 * plain sentence; the interface then shows the expression itself.
 */
export function scheduleInWords(trigger: RoutineTrigger, ctx: TimeContext): string | null {
  const { i18n } = ctx;
  switch (trigger._tag) {
    case "webhook":
      return i18n.t("schedule.webhook");
    case "once":
      return i18n.t("schedule.once", { when: fullTime(trigger.at, ctx) });
    case "schedule":
      return cronInWords(
        trigger.cron,
        i18n,
        trigger.timeZone === ctx.timeZone ? null : zoneName(trigger.timeZone, ctx),
      );
  }
}

/**
 * A time zone as the language names it today, such as "Western European
 * Time" (a zone's name follows its rules, which change over the years); its
 * id if this runtime does not know it.
 */
function zoneName(timeZone: string, { i18n, now }: TimeContext): string {
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

/** `zone` is null when the schedule runs in the operator's own time zone. */
function cronInWords(cron: string, i18n: I18n, zone: string | null): string | null {
  const schedule = readCron(cron);
  if (schedule === null) return null;
  switch (schedule._tag) {
    case "everyMinutes":
      return i18n.plural("schedule.everyMinutes", schedule.minutes);
    case "hourly": {
      // A zone whose offset is not whole hours moves the minute too, so it is named here as well.
      const minute = twoDigits(schedule.minute);
      return zone === null
        ? i18n.t("schedule.hourly", { minute })
        : i18n.t("schedule.hourly.zoned", { minute, zone });
    }
    case "everyHours": {
      const minute = twoDigits(schedule.minute);
      return zone === null
        ? i18n.plural("schedule.everyHours", schedule.hours, { minute })
        : i18n.plural("schedule.everyHours.zoned", schedule.hours, { minute, zone });
    }
    case "monthly": {
      const { day } = schedule;
      const time = timeOfDay(schedule.at, i18n);
      return zone === null
        ? i18n.t("schedule.monthly", { day, time })
        : i18n.t("schedule.monthly.zoned", { day, time, zone });
    }
    case "daily": {
      const time = timeOfDay(schedule.at, i18n);
      return zone === null
        ? i18n.t("schedule.daily", { time })
        : i18n.t("schedule.daily.zoned", { time, zone });
    }
    case "weekdays": {
      const time = timeOfDay(schedule.at, i18n);
      return zone === null
        ? i18n.t("schedule.weekdays", { time })
        : i18n.t("schedule.weekdays.zoned", { time, zone });
    }
    case "weekends": {
      const time = timeOfDay(schedule.at, i18n);
      return zone === null
        ? i18n.t("schedule.weekends", { time })
        : i18n.t("schedule.weekends.zoned", { time, zone });
    }
    case "onDays": {
      const time = timeOfDay(schedule.at, i18n);
      const names = schedule.days.map((d) =>
        new Intl.DateTimeFormat(i18n.locale, { weekday: "long", timeZone: "UTC" }).format(
          // 2000-01-02 was a Sunday.
          Date.UTC(2000, 0, 2 + d),
        ),
      );
      const days = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names);
      return zone === null
        ? i18n.t("schedule.onDays", { days, time })
        : i18n.t("schedule.onDays.zoned", { days, time, zone });
    }
  }
}

const twoDigits = (n: number) => String(n).padStart(2, "0");

const timeOfDay = ({ hour, minute }: TimeOfDay, i18n: I18n) =>
  formatMoment(
    new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short", timeZone: "UTC" }),
    Date.UTC(2000, 0, 1, hour, minute),
  );
