// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRoster } from "@j3-bots/client-runtime/react";
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";

export const itemName = (item: RosterItem): string =>
  item._tag === "bot" ? item.bot.profile.name : item.room.name;

/** The bot or room `key` names, as the roster has it now: `null` once it is gone. */
export const useRosterItem = (key: RosterItemKey): RosterItem | null => {
  const roster = useRoster();
  const wanted = rosterKeyText(key);
  return roster?.rows.find((item) => rosterKeyText(rosterKeyOf(item)) === wanted) ?? null;
};
