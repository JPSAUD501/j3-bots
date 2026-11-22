// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { Label, PositiveInt } from "./base.ts";

/** An IANA time zone name, such as `America/Sao_Paulo`. The server checks that it exists. */
export const TimeZone = Label.pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

/** A clock reading's fields, at the minute, in the zone it was read in. */
const CLOCK_FIELDS = {
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * Whether `timeZone` keeps UTC's clock through `year`: the same reading as
 * UTC in every month, so no offset and no daylight saving. Such a zone says
 * nothing about where its device is: it is what a browser that hides its
 * zone, a machine whose zone was never set or an emulator reports. False
 * for a zone this runtime does not know.
 */
export const keepsUtcClock = (timeZone: string, year: number): boolean => {
  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat("en-US", { ...CLOCK_FIELDS, timeZone });
  } catch {
    return false;
  }
  return Array.from({ length: 12 }, (_, month) => Date.UTC(year, month, 15)).every((at) => {
    const reading = new Map(clock.formatToParts(at).map((part) => [part.type, Number(part.value)]));
    const field = (type: Intl.DateTimeFormatPartTypes) => reading.get(type) ?? Number.NaN;
    const read = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
    );
    return read === at;
  });
};

/**
 * The limits that keep bots from spending the operator's allowance on each
 * other. A room's own hop limit overrides `hops` for that room.
 */
export const Budgets = Schema.Struct({
  /** Consecutive bot-caused wakes in one chain since the operator last spoke. */
  hops: PositiveInt,
  /** Teammates one bot turn may message, and bots one bot message in a room may mention. */
  fanOut: PositiveInt,
  /** Turns running at once across all bots. */
  concurrentTurns: PositiveInt,
});
export type Budgets = typeof Budgets.Type;

/** What the operator wants to be told about, and how much a notification may say. */
export const NotificationSettings = Schema.Struct({
  /** Whether the server notifies at all, on any device. */
  enabled: Schema.Boolean,
  /**
   * Whether a notification carries the first line of what the bot wrote, or
   * only who wrote it. A notification can show where others see it, such as
   * on a locked screen, so this is off until the operator turns it on.
   */
  previews: Schema.Boolean,
});
export type NotificationSettings = typeof NotificationSettings.Type;

/**
 * A change to the notification settings. A field left out keeps its value, so
 * a device that changes one never writes back a stale copy of the other.
 */
export const NotificationSettingsChange = Schema.Struct({
  enabled: Schema.optionalKey(NotificationSettings.fields.enabled),
  previews: Schema.optionalKey(NotificationSettings.fields.previews),
});
export type NotificationSettingsChange = typeof NotificationSettingsChange.Type;

/** The operator's preferences. One per server; every field always has a value. */
export const Settings = Schema.Struct({
  /**
   * What bots call the operator, in their instructions and their replies. Null
   * until the operator gives one; bots then say "your user".
   */
  operatorName: Schema.NullOr(Label),
  /** Where routines' schedules are evaluated and what envelopes report times in. */
  timeZone: TimeZone,
  budgets: Budgets,
  notifications: NotificationSettings,
});
export type Settings = typeof Settings.Type;
