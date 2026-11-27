// SPDX-License-Identifier: AGPL-3.0-or-later
import { isHidden } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";

export const itemName = (item: RosterItem): string =>
  item._tag === "bot" ? item.bot.profile.name : item.room.name;

/** The bots and rooms behind the scenes, by name, as the screen behind the scenes lists them. */
export const backstageItems = (items: ReadonlyArray<RosterItem>): ReadonlyArray<RosterItem> =>
  items.filter(isHidden).toSorted((a, b) => itemName(a).localeCompare(itemName(b)));

/** Where the bot or room a roster key names stands. */
export type RosterItemLookup =
  | { readonly _tag: "loading" }
  | { readonly _tag: "gone" }
  | { readonly _tag: "found"; readonly item: RosterItem };

/**
 * The bot or room `key` names, as the roster has it now. Bots and rooms
 * behind the scenes count: a conversation stays open when it goes there, and
 * a notification, a mention, a notice or a share can open one. Until the roster first loads, nothing
 * is known about it yet.
 */
export const useRosterItem = (key: RosterItemKey): RosterItemLookup => {
  const roster = useReadable(useJ3Client().roster);
  if (roster._tag === "loading") return { _tag: "loading" };
  const wanted = rosterKeyText(key);
  const item = roster.value.find((each) => rosterKeyText(rosterKeyOf(each)) === wanted);
  return item === undefined ? { _tag: "gone" } : { _tag: "found", item };
};
