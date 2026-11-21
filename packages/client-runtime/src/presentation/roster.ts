// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { needsOperator } from "../stores/Roster.ts";

/**
 * Whether the operator can stop the bot: a turn runs, or background work holds
 * a change of its settings, which stopping applies.
 */
export const canStop = (bot: Bot): boolean =>
  bot.state._tag === "thinking" || bot.state._tag === "working" || bot.settingsHeld;

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

/** Pinned rows first, then rows that need the operator, then the most recently active. */
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
