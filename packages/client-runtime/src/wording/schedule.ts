// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EventStopReason,
  type EventTrigger,
  keepsUtcClock,
  type OwnTrigger,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type { TrackTrigger } from "../presentation/routineTrack.ts";
import * as DateTime from "effect/DateTime";
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
export function scheduleInWords(trigger: OwnTrigger, ctx: TimeContext): string | null {
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
 * A connector's event as a routine's trigger, in words: "When Mail says a new
 * email from Ana arrives", with the bot's own words for the event.
 * `connector` is the connector's name, null once it is removed.
 */
export function eventInWords(trigger: EventTrigger, connector: string | null, i18n: I18n): string {
  return connector === null
    ? i18n.t("schedule.eventRemoved", { summary: trigger.summary })
    : i18n.t("schedule.event", { connector, summary: trigger.summary });
}

/** A trigger the Track shows in words, as `scheduleInWords` and `eventInWords` say it. */
export const triggerInWords = (trigger: TrackTrigger, ctx: TimeContext): string | null =>
  trigger._tag === "event"
    ? eventInWords(trigger, trigger.connector, ctx.i18n)
    : scheduleInWords(trigger, ctx);

/**
 * Why J3 Bots stopped listening for a routine's event, as a phrase that
 * follows "Stopped:": "Mail no longer allows it". Null for a reason this
 * client does not know. `connector` is the connector's name, null once it is
 * removed.
 */
export function eventStopText(
  reason: EventStopReason | "unknown",
  connector: string | null,
  i18n: I18n,
): string | null {
  const named = connector ?? i18n.t("routine.theConnector");
  switch (reason) {
    case "access-revoked":
      return i18n.t("routine.stopped.accessRevoked", { connector: named });
    case "event-gone":
      return i18n.t("routine.stopped.eventGone", { connector: named });
    case "connector-gone":
      return i18n.t("routine.stopped.connectorGone");
    case "refused":
      return i18n.t("routine.stopped.refused", { connector: named });
    case "unknown":
      return null;
  }
}

/** A time zone as the language names it, "Brasília Standard Time"; null for one this runtime does not know. */
function timeZoneName(timeZone: string, ctx: TimeContext): string | null {
  return knownTimeZone(timeZone) === null ? null : zoneName(timeZone, ctx);
}

/** What the time zone setting says under its field: the zone's name, when known, and what it sets. */
export function timeZoneHint(timeZone: string, ctx: TimeContext): string {
  const name = timeZoneName(timeZone, ctx);
  return name === null
    ? ctx.i18n.t("settings.timeZone.hint")
    : ctx.i18n.t("settings.timeZone.named", { zone: name });
}

/** A device's own time zone, as Settings offers it in one press. */
interface DeviceZoneOffer {
  /** The zone as this device names it, in its canonical case. */
  readonly zone: string;
  /** The zone as the language names it. */
  readonly name: string;
}

/**
 * The device's own time zone for Settings to offer: null when the device
 * names none, one this runtime does not know, or one that keeps UTC's clock
 * all year, which a device reports when it hides its zone or never had one
 * set. The server passes those over too.
 */
export function deviceZoneOffer(
  deviceZone: string | null,
  ctx: TimeContext,
): DeviceZoneOffer | null {
  const zone = deviceZone === null ? null : knownTimeZone(deviceZone);
  if (zone === null || keepsUtcClock(zone, DateTime.toPartsUtc(ctx.now).year)) return null;
  return { zone, name: zoneName(zone, ctx) };
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
