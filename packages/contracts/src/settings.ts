// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Label, MAX_LABEL_LENGTH, PositiveInt } from "./base.ts";
import { UpdateChannel } from "./update.ts";

/** An IANA time zone name, such as `America/Sao_Paulo`. The server checks that it exists. */
export const TimeZone = Label.pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

/** A line break, a tab or any other control character, which a name cannot hold. */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * What the operator asked to be called, as the operator saves it in Settings
 * and a bot saves it with `set_operator_name`: trimmed, and one line of a
 * label's length. Every bot's instructions open with it, so a line break or a
 * control character would let a name write instructions of its own.
 */
export const OperatorName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_LABEL_LENGTH),
  Schema.makeFilter((name: string) =>
    NOT_ONE_LINE.test(name)
      ? "A name is one line: it cannot hold a line break, a tab or another control character."
      : true,
  ),
);

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
  /** Teammates one bot turn may message. */
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
  /**
   * Which releases the server is offered (`UPDATE_HTTP_PATHS`). `stable`
   * from a server that predates update channels, which offers no update.
   */
  updateChannel: UpdateChannel.pipe(Schema.withDecodingDefaultKey(Effect.succeed("stable"))),
});
export type Settings = typeof Settings.Type;

/**
 * What `settings.update` changes. A field left out keeps its value; a null
 * name clears it. The name is the operator's as a bot would save it.
 */
export const SettingsChange = Schema.Struct({
  operatorName: Schema.optionalKey(Schema.NullOr(OperatorName)),
  timeZone: Schema.optionalKey(TimeZone),
  budgets: Schema.optionalKey(Budgets),
  notifications: Schema.optionalKey(NotificationSettingsChange),
  /**
   * Sent only to a server whose `ServerInfo.updateApi` is set: an older one
   * would take the rest of the change and drop it.
   */
  updateChannel: Schema.optionalKey(UpdateChannel),
});
export type SettingsChange = typeof SettingsChange.Type;
