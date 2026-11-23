// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItemKey } from "@j3-bots/contracts";
import type { RosterIntents } from "../components/RosterMenu";
import type { ShellIntents } from "./data";

/** What the roster's menus do, from the shell's intents; `openDetails` opens a row beside its details. */
export const rosterIntents = (
  intents: ShellIntents,
  openDetails: (key: RosterItemKey) => void,
): RosterIntents => ({
  placeBot: intents.placeBot,
  pinRoom: intents.pinRoom,
  markRead: intents.markRosterRead,
  markUnread: intents.markUnread,
  createSection: intents.createSection,
  updateSection: intents.updateSection,
  deleteSection: intents.deleteSection,
  openDetails,
  deleteBot: intents.deleteBot,
  ...(intents.editProfile === undefined ? {} : { editProfile: intents.editProfile }),
});
