// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineTrigger } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import {
  minuteText,
  readCron,
  timeOfDayText,
  weekdayList,
  zoneName,
} from "../presentation/schedule.ts";
import { fullTime, knownTimeZone } from "../presentation/time.ts";
import type { TimeContext } from "./time.ts";

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

/** A time zone as the language names it, "Brasília Standard Time"; null for one this runtime does not know. */
export function timeZoneName(timeZone: string, ctx: TimeContext): string | null {
  return knownTimeZone(timeZone) === null ? null : zoneName(timeZone, ctx);
}

/** What the time zone setting says under its field: the zone's name, when known, and what it sets. */
export function timeZoneHint(timeZone: string, ctx: TimeContext): string {
  const name = timeZoneName(timeZone, ctx);
  return name === null
    ? ctx.i18n.t("settings.timeZone.hint")
    : ctx.i18n.t("settings.timeZone.named", { zone: name });
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
      const minute = minuteText(schedule.minute);
      return zone === null
        ? i18n.t("schedule.hourly", { minute })
        : i18n.t("schedule.hourly.zoned", { minute, zone });
    }
    case "everyHours": {
      const minute = minuteText(schedule.minute);
      return zone === null
        ? i18n.plural("schedule.everyHours", schedule.hours, { minute })
        : i18n.plural("schedule.everyHours.zoned", schedule.hours, { minute, zone });
    }
    case "monthly": {
      const { day } = schedule;
      const time = timeOfDayText(schedule.at, { i18n });
      return zone === null
        ? i18n.t("schedule.monthly", { day, time })
        : i18n.t("schedule.monthly.zoned", { day, time, zone });
    }
    case "daily": {
      const time = timeOfDayText(schedule.at, { i18n });
      return zone === null
        ? i18n.t("schedule.daily", { time })
        : i18n.t("schedule.daily.zoned", { time, zone });
    }
    case "weekdays": {
      const time = timeOfDayText(schedule.at, { i18n });
      return zone === null
        ? i18n.t("schedule.weekdays", { time })
        : i18n.t("schedule.weekdays.zoned", { time, zone });
    }
    case "weekends": {
      const time = timeOfDayText(schedule.at, { i18n });
      return zone === null
        ? i18n.t("schedule.weekends", { time })
        : i18n.t("schedule.weekends.zoned", { time, zone });
    }
    case "onDays": {
      const time = timeOfDayText(schedule.at, { i18n });
      const days = weekdayList(schedule.days, { i18n });
      return zone === null
        ? i18n.t("schedule.onDays", { days, time })
        : i18n.t("schedule.onDays.zoned", { days, time, zone });
    }
  }
}
