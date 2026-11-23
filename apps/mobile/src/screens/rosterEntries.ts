// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ArrangedRoster,
  type BotItem,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import type { RosterItem, Section, SectionId } from "@j3-bots/contracts";
import { layout } from "@j3-bots/design-tokens";

/** A bot's or room's row. */
const ROW_HEIGHT = layout.rowHeight.touch;

/** A pinned bot's avatar, which stands larger than a row's. */
export const PIN_AVATAR = 64;

/** Geometry of the pinned bots' band, in px. */
const pin = {
  /** The avatar, the gap under it and one line of name. */
  cell: PIN_AVATAR + 8 + 20,
  /** The least width a pinned bot takes, so a name of a few words fits under its avatar. */
  minWidth: 88,
  rowGap: 12,
  top: 4,
  bottom: 12,
  /** The list's own inset on each side. */
  inset: 8,
} as const;

/** The row that opens the hidden bots, at the end of the list. */
export const HIDDEN_ROW_HEIGHT = 56;

/** A section's header: its name, which folds it, with room above to set it apart. */
export const SECTION_HEIGHT = 48;

/** The line an open section with no bots shows. */
export const SECTION_EMPTY_HEIGHT = 40;

/**
 * One thing the roster lists, with the key the list knows it by and the
 * height it takes: every entry's height is known, so the list places one
 * without measuring it, and a reorder knows how far each moved.
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
  /** The way to the hidden bots, listed while any is. */
  | {
      readonly kind: "hidden";
      readonly key: "hidden";
      readonly height: number;
      readonly bots: ReadonlyArray<BotItem>;
    };

/** How many pinned bots stand side by side in a list `width` px wide. */
export const pinColumns = (width: number): number =>
  Math.max(1, Math.floor((width - 2 * pin.inset) / pin.minWidth));

/** How tall the band of `count` pinned bots is, `columns` to a line. */
export const pinnedHeight = (count: number, columns: number): number => {
  if (count === 0) return 0;
  const lines = Math.ceil(count / columns);
  return pin.top + lines * pin.cell + (lines - 1) * pin.rowGap + pin.bottom;
};

/** The pinned band's geometry, for the band to draw itself by. */
export const PIN_BAND = pin;

const row = (item: RosterItem): RosterEntry => ({
  kind: "row",
  key: rosterKeyText(rosterKeyOf(item)),
  height: ROW_HEIGHT,
  item,
});

/**
 * A section's header, then its bots unless it is folded, or, open with none,
 * the line that says so. A bot keeps its row's key wherever it is, so moving
 * it into or out of a section moves its row.
 */
const sectionEntries = (
  { section, items }: ArrangedRoster["sections"][number],
  folded: boolean,
): ReadonlyArray<RosterEntry> => {
  const header: RosterEntry = {
    kind: "section",
    key: `section:${section.id}`,
    height: SECTION_HEIGHT,
    section,
    count: items.length,
    unread: items.some((item) => item.unread),
    folded,
  };
  if (folded) return [header];
  if (items.length === 0) {
    return [header, { kind: "empty", key: `empty:${section.id}`, height: SECTION_EMPTY_HEIGHT }];
  }
  return [header, ...items.map(row)];
};

/**
 * What the roster lists in a list `width` px wide: the pinned bots' band,
 * the rows in no section, each section in the operator's order, and the way
 * to the hidden bots last. `folded` are the sections folded on this phone.
 */
export const rosterEntries = (
  arranged: ArrangedRoster,
  width: number,
  folded: ReadonlySet<SectionId>,
): ReadonlyArray<RosterEntry> => {
  const columns = pinColumns(width);
  const pinned: RosterEntry = {
    kind: "pinned",
    key: "pinned",
    height: pinnedHeight(arranged.pinned.length, columns),
    bots: arranged.pinned,
    columns,
  };
  const hidden: ReadonlyArray<RosterEntry> =
    arranged.hidden.length === 0
      ? []
      : [{ kind: "hidden", key: "hidden", height: HIDDEN_ROW_HEIGHT, bots: arranged.hidden }];
  return [
    pinned,
    ...arranged.main.map(row),
    ...arranged.sections.flatMap((each) => sectionEntries(each, folded.has(each.section.id))),
    ...hidden,
  ];
};

/** What a search lists: only the rows that match, as rows. */
export const foundEntries = (found: ReadonlyArray<RosterItem>): ReadonlyArray<RosterEntry> =>
  found.map(row);
