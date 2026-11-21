// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { needsOperator } from "../stores/Roster.ts";

/**
 * Whether the operator can stop the bot: a turn runs, or background work holds
 * a change of its settings, which stopping applies.
 */
export const canStop = (bot: Bot): boolean =>
  bot.state._tag === "thinking" || bot.state._tag === "working" || bot.settingsHeld;

/**
 * Whether a room's header offers Stop: `stopping` while the operator's Stop
 * is on its way to the server.
 */
export type RoomStop = "hidden" | "offered" | "stopping";

/**
 * A client cannot tell whom a bot works for, so an active room offers Stop
 * while any of its members is thinking or working; the Stop ends only the
 * room's work, and a member busy elsewhere goes on. Work the room's turns
 * left running in the background shows in no state a client has, so it alone
 * offers no Stop. An archived room has nothing to stop: archiving stopped it.
 * `bots` may hold bots that are not members; only members count.
 */
export const roomStop = (room: Room, bots: Iterable<Bot>, stopping: boolean): RoomStop => {
  if (room.status === "archived") return "hidden";
  if (stopping) return "stopping";
  for (const bot of bots) {
    if (
      room.members.includes(bot.id) &&
      (bot.state._tag === "thinking" || bot.state._tag === "working")
    ) {
      return "offered";
    }
  }
  return "hidden";
};

/** Which bot or room a roster item is. */
export const rosterKeyOf = (item: RosterItem): RosterItemKey =>
  item._tag === "bot"
    ? { _tag: "bot", botId: item.bot.id }
    : { _tag: "room", roomId: item.room.id };

/**
 * A bot or room as one string: what a roster row is marked with, and what the
 * shell keeps a conversation's draft and timeline under.
 */
export const rosterKeyText = (key: RosterItemKey): string =>
  key._tag === "bot" ? `bot:${key.botId}` : `room:${key.roomId}`;

const isPinned = (item: RosterItem) => (item._tag === "bot" ? item.bot.pinned : item.room.pinned);

/**
 * Pinned rows first, then rows that need the operator, then the most recently
 * active. This is the web roster's order, and not yet `rosterRows`': that one
 * also leaves hidden bots out and breaks a tie by name, where this keeps the
 * order the rows came in. Issue #54 merges the two into one order.
 */
export function orderRoster(items: ReadonlyArray<RosterItem>): RosterItem[] {
  const recency = (item: RosterItem) =>
    item.lastActivityAt === null ? -Infinity : DateTime.toEpochMillis(item.lastActivityAt);
  return items
    .map((item) => ({
      item,
      pinned: isPinned(item),
      needs: needsOperator(item),
      at: recency(item),
    }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || Number(b.needs) - Number(a.needs) || b.at - a.at,
    )
    .map(({ item }) => item);
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The rows to show for a search. Without a query, hidden bots stay out of the
 * roster; a query finds them too.
 */
export function filterRoster(items: ReadonlyArray<RosterItem>, query: string): RosterItem[] {
  const q = fold(query.trim());
  if (q === "") return items.filter((item) => item._tag !== "bot" || !item.bot.hidden);
  return items.filter((item) => {
    const names =
      item._tag === "bot" ? [item.bot.profile.name, item.bot.profile.title] : [item.room.name];
    return names.some((n) => fold(n).includes(q));
  });
}

/**
 * A message's text as one line, for a row's preview: code blocks left out
 * and every run of white space one space.
 */
export const firstLine = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
