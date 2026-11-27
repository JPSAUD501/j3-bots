// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ArrangedRoster,
  type BotItem,
  pairKeyText,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import type { RosterItem, Section, SectionId, TeammatePair } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";
import type { TextLines } from "../lines.tsx";

/** A pinned bot's avatar, which stands larger than a row's. */
export const PIN_AVATAR = 64;

/** Geometry of the pinned bots' band, in px. */
const pin = {
  /** The least width a pinned bot takes, so a name of a few words fits under its avatar. */
  minWidth: 88,
  rowGap: 12,
  top: 4,
  bottom: 12,
  /** The list's own inset on each side. */
  inset: 8,
} as const;

/**
 * How tall each kind of thing the roster lists is, in px, from how tall its
 * text's lines are on this phone (`TextLines`): at the default font size
 * each is the height the design sets, and at a larger one it grows with its
 * text, so its lines never touch the next.
 */
export interface RosterSizes {
  /** A bot's or room's row: its name over its status line. */
  readonly row: number;
  /** A line of a bot's title, which goes between its name and its status line (`rowHeight`). */
  readonly titleLine: number;
  /** A section's header: its name, with room above to set it apart. */
  readonly section: number;
  /** The line an open section with no bots shows. */
  readonly empty: number;
  /** The row that opens the bots and rooms behind the scenes, at the end of the list. */
  readonly backstage: number;
  /** A pinned bot: its avatar, the gap under it and one line of name. */
  readonly pinCell: number;
}

export const rosterSizes = (lines: TextLines): RosterSizes => ({
  // The name, 2 px, the status line, and at least 9 px above and below.
  row: Math.max(layout.rowHeight.touch, lines.base + 2 + lines.sm + 2 * 9),
  titleLine: lines.xs,
  // The name sits 8 px off the bottom, with at least 18 px above it.
  section: Math.max(48, lines.sm + 26),
  empty: Math.max(40, lines.sm + 2 * 9),
  backstage: Math.max(56, lines.base + 2 * 17),
  pinCell: PIN_AVATAR + 8 + lines.sm,
});

/**
 * One thing the roster lists, with the key the list knows it by and the
 * height it takes: every entry's height is known before it is drawn, from
 * `RosterSizes`, so the list places one without measuring it, and a reorder
 * knows how far each moved.
 */
export type RosterEntry =
  /**
   * The pinned bots, as large avatars in a band at the top, in `columns`
   * per line. The band is always listed, with no height while nothing is
   * pinned, so a bot pinned first pops in rather than the band fading in.
   */
  | {
      readonly kind: "pinned";
      readonly key: "pinned";
      readonly height: number;
      readonly bots: ReadonlyArray<BotItem>;
      readonly columns: number;
      /** Each bot's height in the band. */
      readonly cell: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly height: number;
      readonly item: RosterItem;
    }
  /**
   * A section's header, open or folded, with how many bots it holds and
   * whether any of them has something unread, which a folded header shows.
   */
  | {
      readonly kind: "section";
      readonly key: string;
      readonly height: number;
      readonly section: Section;
      readonly count: number;
      readonly unread: boolean;
      readonly folded: boolean;
    }
  /** What an open section with no bots shows in their place. */
  | {
      readonly kind: "empty";
      readonly key: string;
      readonly height: number;
    }
  /**
   * The header of the "Between bots" section, listed while any pair is: the
   * bots' own, which the operator does not arrange.
   */
  | {
      readonly kind: "between";
      readonly key: "between";
      readonly height: number;
    }
  /** The teammate conversation of two bots, under "Between bots", as tall as a row. */
  | {
      readonly kind: "pair";
      readonly key: string;
      readonly height: number;
      readonly pair: TeammatePair;
    }
  /** The way to the bots and rooms behind the scenes, listed while any is. */
  | {
      readonly kind: "backstage";
      readonly key: "backstage";
      readonly height: number;
      readonly items: ReadonlyArray<RosterItem>;
    };

/** How many pinned bots stand side by side in a list `width` px wide. */
export const pinColumns = (width: number): number =>
  Math.max(1, Math.floor((width - 2 * pin.inset) / pin.minWidth));

/** How tall the band of `count` pinned bots is, `columns` to a line, each `cell` tall. */
export const pinnedHeight = (count: number, columns: number, cell: number): number => {
  if (count === 0) return 0;
  const lines = Math.ceil(count / columns);
  return pin.top + lines * cell + (lines - 1) * pin.rowGap + pin.bottom;
};

/** The pinned band's geometry, for the band to draw itself by. */
export const PIN_BAND = pin;

/**
 * How many lines a bot's title takes in its row at the list's width: one or
 * two, as `useTitleLines` reads them.
 */
export type TitleLines = (title: string) => number;

/**
 * How tall a bot's or room's row is: a bot's title, in as many lines as it
 * takes, goes between its name and its status line; a room, or a bot from
 * before titles, has none.
 */
const rowHeight = (sizes: RosterSizes, titleLines: TitleLines, item: RosterItem): number => {
  const title = item._tag === "bot" ? item.bot.profile.title : "";
  return title === "" ? sizes.row : sizes.row + 2 + titleLines(title) * sizes.titleLine;
};

const row =
  (sizes: RosterSizes, titleLines: TitleLines) =>
  (item: RosterItem): RosterEntry => ({
    kind: "row",
    key: rosterKeyText(rosterKeyOf(item)),
    height: rowHeight(sizes, titleLines, item),
    item,
  });

/** The "Between bots" section: its header, then each pair, as `pairs` are ordered, or nothing. */
const betweenEntries = (
  pairs: ReadonlyArray<TeammatePair>,
  sizes: RosterSizes,
): ReadonlyArray<RosterEntry> =>
  pairs.length === 0
    ? []
    : [
        { kind: "between", key: "between", height: sizes.section },
        ...pairs.map((pair): RosterEntry => ({
          kind: "pair",
          key: pairKeyText(pair.botIds),
          height: sizes.row,
          pair,
        })),
      ];

/**
 * A section's header, then its bots unless it is folded, or, open with none,
 * the line that says so. A bot keeps its row's key wherever it is, so moving
 * it into or out of a section moves its row.
 */
const sectionEntries = (
  { section, items }: ArrangedRoster["sections"][number],
  folded: boolean,
  sizes: RosterSizes,
  titleLines: TitleLines,
): ReadonlyArray<RosterEntry> => {
  const header: RosterEntry = {
    kind: "section",
    key: `section:${section.id}`,
    height: sizes.section,
    section,
    count: items.length,
    unread: items.some((item) => item.unread),
    folded,
  };
  if (folded) return [header];
  if (items.length === 0) {
    return [header, { kind: "empty", key: `empty:${section.id}`, height: sizes.empty }];
  }
  return [header, ...items.map(row(sizes, titleLines))];
};

/**
 * What the roster lists in a list `width` px wide: the pinned bots' band,
 * the rows in no section, each section in the operator's order, the pairs
 * of bots that wrote each other (`betweenBots`), and the way to the bots
 * and rooms behind the scenes last. `folded` are the sections folded on this
 * phone.
 */
export const rosterEntries = (
  arranged: ArrangedRoster,
  pairs: ReadonlyArray<TeammatePair>,
  width: number,
  folded: ReadonlySet<SectionId>,
  sizes: RosterSizes,
  titleLines: TitleLines,
): ReadonlyArray<RosterEntry> => {
  const columns = pinColumns(width);
  const pinned: RosterEntry = {
    kind: "pinned",
    key: "pinned",
    height: pinnedHeight(arranged.pinned.length, columns, sizes.pinCell),
    bots: arranged.pinned,
    columns,
    cell: sizes.pinCell,
  };
  const backstage: ReadonlyArray<RosterEntry> =
    arranged.hidden.length === 0
      ? []
      : [{ kind: "backstage", key: "backstage", height: sizes.backstage, items: arranged.hidden }];
  return [
    pinned,
    ...arranged.main.map(row(sizes, titleLines)),
    ...arranged.sections.flatMap((each) =>
      sectionEntries(each, folded.has(each.section.id), sizes, titleLines),
    ),
    ...betweenEntries(pairs, sizes),
    ...backstage,
  ];
};

/**
 * What a search lists: only the rows that match, as rows, then the pairs
 * that match (`filterPairs`) under "Between bots".
 */
export const foundEntries = (
  found: ReadonlyArray<RosterItem>,
  pairs: ReadonlyArray<TeammatePair>,
  sizes: RosterSizes,
  titleLines: TitleLines,
): ReadonlyArray<RosterEntry> => [
  ...found.map(row(sizes, titleLines)),
  ...betweenEntries(pairs, sizes),
];
