// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsOperator, rosterRows } from "@j3-bots/client-runtime";
import type { DeviceId, RosterItem } from "@j3-bots/contracts";
import { TRAY_LISTED, type TrayReport, type Waiting } from "@j3-bots/desktop-bridge";

const waitingOf = (item: RosterItem): Waiting =>
  item._tag === "bot"
    ? { target: { _tag: "conversation", botId: item.bot.id }, name: item.bot.profile.name }
    : { target: { _tag: "room", roomId: item.room.id }, name: item.room.name };

/**
 * What the desktop app's tray lists: the roster's rows that need the
 * operator, in the roster's order, the first `TRAY_LISTED` of them by name
 * and the rest counted. Nothing while the roster is not loaded or the page
 * follows no pairing.
 */
export function trayReport(
  roster: ReadonlyArray<RosterItem> | null,
  pairing: DeviceId | null,
): TrayReport {
  if (roster === null || pairing === null) return { pairing: null, count: 0, waiting: [] };
  const needing = rosterRows(roster).filter(needsOperator);
  return {
    pairing,
    count: needing.length,
    waiting: needing.slice(0, TRAY_LISTED).map(waitingOf),
  };
}
