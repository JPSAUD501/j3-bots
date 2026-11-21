// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DeviceId, type EntryTarget, PushData, type RosterItem } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Synced } from "../stores/synced.ts";

/** A notification the operator opened: what it is about, and the pairing that received it. */
export interface OpenedNotification {
  readonly target: EntryTarget;
  readonly pairing: DeviceId;
}

/** What opening a notification does. */
export type NotificationOpening =
  /** Opens the conversation or room it is about. */
  | { readonly _tag: "open"; readonly target: EntryTarget }
  /** The roster has not loaded yet: decide again once it has. */
  | { readonly _tag: "wait" }
  /**
   * Opens nothing: another pairing received it, or the bot or room it is
   * about is gone, or it says nothing a client can read.
   */
  | { readonly _tag: "drop" };

const drop: NotificationOpening = { _tag: "drop" };
const wait: NotificationOpening = { _tag: "wait" };

const lists = (items: ReadonlyArray<RosterItem>, target: EntryTarget) =>
  items.some((item) =>
    target._tag === "conversation"
      ? item._tag === "bot" && item.bot.id === target.botId
      : item._tag === "room" && item.room.id === target.roomId,
  );

/**
 * What opening `opened` does in a window that follows `pairing`, with
 * `roster` as it holds it. A notification belongs to the pairing that
 * received it: once that pairing ended, it opens nothing, even though it
 * may still be on screen. It opens its conversation or room only while the
 * roster lists it, hidden bots included, so a tap on a notification about a
 * bot deleted since lands nowhere rather than on an empty page. A roster
 * that has not loaded yet, as when the tap itself started the app, cannot
 * say: the caller decides again once it has.
 */
export const notificationOpening = (
  opened: OpenedNotification,
  pairing: DeviceId | null,
  roster: Synced<ReadonlyArray<RosterItem>>,
): NotificationOpening => {
  if (pairing === null || opened.pairing !== pairing) return drop;
  if (roster._tag === "loading") return wait;
  return lists(roster.value, opened.target) ? { _tag: "open", target: opened.target } : drop;
};

const decodePushData = Schema.decodeUnknownOption(PushData);

/**
 * What tapping a push does, from the data the push carried (`PushData`, as
 * the push service hands it to the app): as `notificationOpening`, for the
 * device the server sent it to. Data that does not decode opens nothing.
 */
export const pushOpening = (
  data: unknown,
  pairing: DeviceId | null,
  roster: Synced<ReadonlyArray<RosterItem>>,
): NotificationOpening =>
  Option.match(decodePushData(data), {
    onNone: () => drop,
    onSome: ({ deviceId, target }) =>
      notificationOpening({ target, pairing: deviceId }, pairing, roster),
  });
