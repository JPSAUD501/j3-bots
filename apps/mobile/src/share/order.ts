// SPDX-License-Identifier: AGPL-3.0-or-later
import { isHidden } from "@j3-bots/client-runtime";
import { type BotItem, orderRoster } from "@j3-bots/client-runtime/presentation";
import type { RosterItem } from "@j3-bots/contracts";

/**
 * The bots a share can go to, in the order the share sheet and Direct Share
 * offer them: the one last shared to first, then the roster's order, which
 * puts pinned bots first. Bots and rooms behind the scenes are not offered.
 */
export const shareBots = (
  items: ReadonlyArray<RosterItem>,
  lastSharedTo: string | null,
): ReadonlyArray<BotItem> => {
  const bots = orderRoster(items).filter(
    (item): item is BotItem => item._tag === "bot" && !isHidden(item),
  );
  const last = bots.find((item) => item.bot.id === lastSharedTo);
  return last === undefined ? bots : [last, ...bots.filter((item) => item !== last)];
};
