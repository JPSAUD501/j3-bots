// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget, RosterItemKey } from "@j3-bots/contracts";
import type { RosterIntents } from "../components/RosterMenu";
import type { ShellIntents } from "./data";

/** What the roster's menus need of the shell's navigation. */
export interface RosterNavigation {
  readonly selected: RosterItemKey | null;
  readonly select: (key: RosterItemKey | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
}

const isTarget = (key: RosterItemKey | null, target: EntryTarget) =>
  key !== null &&
  (target._tag === "conversation"
    ? key._tag === "bot" && key.botId === target.botId
    : key._tag === "room" && key.roomId === target.roomId);

/** What the roster's menus do, from the shell's intents and its navigation. */
export const rosterIntents = (
  intents: ShellIntents,
  navigation: RosterNavigation,
): RosterIntents => ({
  placeBot: intents.placeBot,
  placeRoom: intents.placeRoom,
  markRead: intents.markRosterRead,
  // An open conversation reads what it shows, so it would clear the mark at
  // once: marking it unread leaves it first, and the dot stays.
  markUnread: (target) => {
    if (isTarget(navigation.selected, target)) navigation.select(null);
    intents.markUnread(target);
  },
  createSection: intents.createSection,
  updateSection: intents.updateSection,
  deleteSection: intents.deleteSection,
  openDetails: (key) => {
    navigation.select(key);
    navigation.setDetailsOpen(true);
  },
  shareTemplate: intents.shareBotTemplate,
  deleteBot: intents.deleteBot,
  ...(intents.editProfile === undefined ? {} : { editProfile: intents.editProfile }),
});
