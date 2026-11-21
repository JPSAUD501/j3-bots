// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { Label, PositiveInt } from "./base.ts";

/** An IANA time zone name, such as `America/Sao_Paulo`. The server checks that it exists. */
export const TimeZone = Label.pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

/**
 * The limits that keep bots from spending the operator's allowance on each
 * other. A room's own hop limit overrides `hops` for that room.
 */
export const Budgets = Schema.Struct({
  /** Consecutive bot-caused wakes in one chain since the operator last spoke. */
  hops: PositiveInt,
  /** Bots a single bot message may wake, unless the operator asked for more. */
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
