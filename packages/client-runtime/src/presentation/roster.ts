// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotId,
  EntryTarget,
  Room,
  RosterItem,
  RosterItemKey,
  Section,
  SectionId,
  TeammatePair,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { type IntentResult, refusedWith } from "../intents/Actions.ts";
import { isHidden, needsOperator } from "../stores/Roster.ts";

/**
 * What the bot's Stop offers: `force` while its AI ignores a Stop
 * (`Bot.forceStop`), which a Force stop ends; `offered` while a turn runs, or
 * background work holds a change of its settings, which stopping applies.
 */
export type BotStop = "hidden" | "offered" | "force";

export const botStop = (bot: Bot): BotStop => {
  if (bot.forceStop) return "force";
  return bot.state._tag === "thinking" || bot.state._tag === "working" || bot.settingsHeld
    ? "offered"
    : "hidden";
};

/**
 * What a room's header offers: Stop, `stopping` while the server ends the
 * room's work, which then offers nothing to press, or `force` while a
 * member's AI ignores the Stop (`Room.forceStop`).
 */
export type RoomStop = "hidden" | "offered" | "stopping" | "force";

/**
 * The room's Stop follows the work the server counts for it (`Room.work`):
 * its members' turns for it, the wakes and dispatches waiting for it, and the
 * work its turns left running in the background. An archived room has
 * nothing to stop: archiving stopped it.
 */
export const roomStop = (room: Room): RoomStop => {
  if (room.status === "archived") return "hidden";
  if (room.forceStop) return "force";
  switch (room.work) {
    case "none":
      return "hidden";
    case "running":
      return "offered";
    case "stopping":
      return "stopping";
  }
};

/**
 * Whether a room's Stop that did not take effect is said. A room archived
 * meanwhile shows so, and its archiving stopped its work.
 */
export const roomStopFailed = (result: IntentResult): boolean =>
  result._tag === "failed" && !refusedWith(result, "room-archived");

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

/** The conversation or room a roster row opens. */
export const rosterTarget = (key: RosterItemKey): EntryTarget =>
  key._tag === "bot"
    ? { _tag: "conversation", botId: key.botId }
    : { _tag: "room", roomId: key.roomId };

const isPinned = (item: RosterItem) => (item._tag === "bot" ? item.bot.pinned : item.room.pinned);

const createdAtOf = (item: RosterItem) =>
  item._tag === "bot" ? item.bot.createdAt : item.room.createdAt;

/** Newest activity first; a row with none yet after every row with some. */
const byActivity = (a: RosterItem, b: RosterItem): number => {
  if (a.lastActivityAt === null || b.lastActivityAt === null) {
    if (a.lastActivityAt === b.lastActivityAt) return 0;
    return a.lastActivityAt === null ? 1 : -1;
  }
  return DateTime.Order(b.lastActivityAt, a.lastActivityAt);
};

/** Bots before rooms, each by id, in code-unit order as the server's database sorts them. */
const byKey = (a: RosterItem, b: RosterItem): number => {
  const [x, y] = [rosterKeyText(rosterKeyOf(a)), rosterKeyText(rosterKeyOf(b))];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The roster's order, the server's own, which every client lists: pinned rows
 * first, then rows that need the operator, then the most recently active,
 * then the longest there. Hidden rows keep their place in it: arranging the
 * roster (`arrangeRoster`) and searching it (`filterRoster`) set them apart.
 */
export function orderRoster(items: ReadonlyArray<RosterItem>): RosterItem[] {
  return items.toSorted(
    (a, b) =>
      Number(isPinned(b)) - Number(isPinned(a)) ||
      Number(needsOperator(b)) - Number(needsOperator(a)) ||
      byActivity(a, b) ||
      DateTime.Order(createdAtOf(a), createdAtOf(b)) ||
      byKey(a, b),
  );
}

/** A bot's roster item. */
export type BotItem = Extract<RosterItem, { readonly _tag: "bot" }>;

/** One section as the roster shows it: its bots, in the roster's order, maybe none. */
export interface RosterSectionRows {
  readonly section: Section;
  readonly items: ReadonlyArray<BotItem>;
}

/** The roster arranged as every client draws it without a search. */
export interface ArrangedRoster {
  /** Pinned bots, drawn apart above the list. */
  readonly pinned: ReadonlyArray<BotItem>;
  /** Rooms, pinned ones first, and the bots in no section. */
  readonly main: ReadonlyArray<RosterItem>;
  /** Every section, in the operator's order, also those with no bots. */
  readonly sections: ReadonlyArray<RosterSectionRows>;
  /** Hidden bots and rooms, for the row that opens them. */
  readonly hidden: ReadonlyArray<RosterItem>;
}

/**
 * Arranges rows already in the roster's order (`orderRoster`). A hidden bot
 * or room is only among the hidden, whatever its pin or section; a pinned bot only
 * among the pinned; a bot whose section is not among `sections` (it was just
 * deleted) in the main list. Rooms keep their own pin, at the top of the list.
 */
export function arrangeRoster(
  items: ReadonlyArray<RosterItem>,
  sections: ReadonlyArray<Section>,
): ArrangedRoster {
  const pinned: Array<BotItem> = [];
  const main: Array<RosterItem> = [];
  const hidden: Array<RosterItem> = [];
  const bySection = new Map(sections.map((section) => [section.id, [] as Array<BotItem>]));
  for (const item of items) {
    if (isHidden(item)) hidden.push(item);
    else if (item._tag === "room") main.push(item);
    else if (item.bot.pinned) pinned.push(item);
    else {
      const section = item.bot.sectionId === null ? undefined : bySection.get(item.bot.sectionId);
      if (section === undefined) main.push(item);
      else section.push(item);
    }
  }
  return {
    pinned,
    main,
    sections: sections.map((section) => ({ section, items: bySection.get(section.id) ?? [] })),
    hidden,
  };
}

/**
 * The rows of an arranged roster in the order they are drawn, as the keys
 * that move between conversations walk them: the hidden rows and the bots in a
 * section `folded` says is folded are not drawn.
 */
export const arrangedOrder = (
  arranged: ArrangedRoster,
  folded: (sectionId: SectionId) => boolean,
): ReadonlyArray<RosterItem> => [
  ...arranged.pinned,
  ...arranged.main,
  ...arranged.sections.flatMap(({ section, items }) => (folded(section.id) ? [] : items)),
];

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The rows to show for a search. Without a query, hidden bots and rooms stay
 * out of the roster; a query finds them too.
 */
export function filterRoster(items: ReadonlyArray<RosterItem>, query: string): RosterItem[] {
  const q = fold(query.trim());
  if (q === "") return items.filter((item) => !isHidden(item));
  return items.filter((item) => {
    const names =
      item._tag === "bot" ? [item.bot.profile.name, item.bot.profile.title] : [item.room.name];
    return names.some((n) => fold(n).includes(q));
  });
}

/** How many of a room's members its header draws before it counts the rest. */
const HEADER_FACES = 3;

/**
 * A room's members as its header draws them: the first three, overlapped,
 * then how many more it has ("+2"), or 0 when it shows them all.
 */
export function memberStack<A>(members: ReadonlyArray<A>): {
  readonly shown: ReadonlyArray<A>;
  readonly more: number;
} {
  return {
    shown: members.slice(0, HEADER_FACES),
    more: Math.max(0, members.length - HEADER_FACES),
  };
}

/** The bots of a roster, by id. */
const botsOf = (items: ReadonlyArray<RosterItem>): ReadonlyMap<BotId, Bot> =>
  new Map(items.flatMap((item) => (item._tag === "bot" ? [[item.bot.id, item.bot] as const] : [])));

/**
 * The pairs the roster's "Between bots" section lists, after the bots and
 * rooms, latest first as `pairs` are: those whose two bots the roster still
 * shows. A pair with a hidden or deleted bot leaves it; the other bot's
 * details still reach it (`teammatesOf`).
 */
export function betweenBots(
  pairs: ReadonlyArray<TeammatePair>,
  items: ReadonlyArray<RosterItem>,
): ReadonlyArray<TeammatePair> {
  const bots = botsOf(items);
  const shown = (id: BotId) => {
    const bot = bots.get(id);
    return bot !== undefined && !bot.hidden;
  };
  return pairs.filter(({ botIds: [low, high] }) => shown(low) && shown(high));
}

/**
 * The pairs to show for a search: those where either bot's name or title
 * matches, as `filterRoster` finds the bot.
 * Like `filterRoster`, a query finds a hidden bot's pairs too; a deleted
 * bot's are only in the other bot's details.
 */
export function filterPairs(
  pairs: ReadonlyArray<TeammatePair>,
  items: ReadonlyArray<RosterItem>,
  query: string,
): ReadonlyArray<TeammatePair> {
  const q = fold(query.trim());
  if (q === "") return betweenBots(pairs, items);
  const bots = botsOf(items);
  return pairs.filter(({ botIds }) => {
    const found = botIds.map((id) => bots.get(id));
    return (
      found.every((bot) => bot !== undefined) &&
      found.some(
        (bot) =>
          bot !== undefined &&
          [bot.profile.name, bot.profile.title].some((name) => fold(name).includes(q)),
      )
    );
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
