// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  keptRow,
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
  rowTops,
} from "@j3-bots/client-runtime/presentation";
import { lift } from "@j3-bots/design-tokens";
import type { RosterEntry } from "../screens/rosterEntries.ts";

type Moves = ReadonlyMap<string, RowMove>;

/** A row the list shows: its key, and the height it takes, known without measuring it. */
export type ListedRow = Pick<RosterEntry, "key" | "height">;

/** The rows as the roster shows them, and the search that chose them. */
export interface ShownRows {
  readonly rows: ReadonlyArray<ListedRow>;
  readonly query: string;
}

/**
 * The mark a scrolled list keeps its place by (`KeptScroll`): the list
 * scrolls as far as the mark moves down it, as it moves.
 */
interface Mark {
  /** How far down the list it is, in px: every move of a row the list kept in place, summed. */
  readonly top: number;
  /**
   * How long it waits before it travels there, in ms, the same as the row it
   * keeps in place; `null` when it goes at once, as under reduced motion.
   */
  readonly delay: number | null;
}

/** How the roster's rows move in the order now drawn. */
export interface RowMotion {
  /** How each row moves, by key; none at rest, and none under reduced motion. */
  readonly moves: Moves;
  /**
   * The rows up off the list: each row a move lifted, until the rows settle, so
   * a row a burst only pushes along stays up until it arrives.
   */
  readonly lifted: ReadonlySet<string>;
  /** The rows still on their way from a move before this one, which set off again at once. */
  readonly moving: ReadonlySet<string>;
  /** The rows new to the list, which fade in as the others make room. */
  readonly arrived: ReadonlySet<string>;
  /** What keeps the list's place while scrolled, under reduced motion too. */
  readonly mark: Mark;
}

/** What the roster last drew: its rows, how they move, and where the list is on its way to. */
export interface Drawn {
  /** `null` while the roster is not shown. */
  readonly view: ShownRows | null;
  readonly motion: RowMotion;
  /**
   * Where the list will be scrolled, in px, once it has kept its place, while
   * it is on its way there: a burst keeps the row first in view there.
   */
  readonly heading: number | null;
}

const noMoves: Moves = new Map();
const noRows: ReadonlySet<string> = new Set();

/** `motion` once its rows have arrived: the same, when none was moving. */
const rested = (motion: RowMotion): RowMotion =>
  motion.moves.size === 0
    ? motion
    : {
        moves: noMoves,
        lifted: noRows,
        moving: noRows,
        arrived: noRows,
        mark: { top: motion.mark.top, delay: null },
      };

/** Before the roster drew anything. */
export const undrawn: Drawn = {
  view: null,
  motion: {
    moves: noMoves,
    lifted: noRows,
    moving: noRows,
    arrived: noRows,
    mark: { top: 0, delay: null },
  },
  heading: null,
};

/** Whether `drawn` already shows `view`. */
export const shows = ({ view: shown }: Drawn, view: ShownRows | null): boolean =>
  shown === null || view === null
    ? shown === view
    : shown.query === view.query &&
      shown.rows.length === view.rows.length &&
      shown.rows.every(
        (row, index) =>
          row.key === view.rows[index]?.key && row.height === view.rows[index]?.height,
      );

/** Whether `drawn` has yet to settle: rows on their way, or the list on its way to its place. */
export const unsettled = ({ motion, heading }: Drawn): boolean =>
  motion.moves.size > 0 || heading !== null;

/** `drawn` once the rows have arrived and the list is in its place. */
export const settled = (drawn: Drawn): Drawn => ({
  ...drawn,
  motion: rested(drawn.motion),
  heading: null,
});

/**
 * `drawn` once the operator takes the list: it is scrolled where they put it,
 * no longer on its way anywhere.
 */
export const taken = (drawn: Drawn): Drawn =>
  drawn.heading === null ? drawn : { ...drawn, heading: null };

const keysOf = (view: ShownRows): RosterView => ({
  keys: view.rows.map((row) => row.key),
  query: view.query,
});

/** Where each row of `view` starts, in px down the list, by key. */
const topsOf = (view: ShownRows): ReadonlyMap<string, number> => {
  const tops = rowTops(view.rows.map((row) => row.height));
  return new Map(view.rows.map((row, index) => [row.key, tops[index] ?? 0]));
};

/**
 * The moves from `before` to `after` (`rosterMotion`), and with them every
 * row that stays in order but starts somewhere else, as the rows under a band
 * that grew: each steps to its new place too.
 */
function movesBetween(before: ShownRows | null, after: ShownRows): Moves {
  const moves = rosterMotion(before === null ? null : keysOf(before), keysOf(after));
  if (before === null || before.query !== after.query) return moves;
  const was = topsOf(before);
  const shifted = [...topsOf(after)].filter(
    ([key, top]) => !moves.has(key) && (was.get(key) ?? top) !== top,
  );
  if (shifted.length === 0) return moves;
  return new Map([...moves, ...shifted.map(([key]) => [key, "step"] as const)]);
}

/**
 * The row a list scrolled to `offset` keeps where it is on screen as its rows
 * go from `before` to `after` (`keptRow`), and how far that row moved, in px;
 * `null` when no row stays there, or the one that does has not moved. At the
 * top the list stays at the top, where a row that rises comes into view.
 */
function keptMove(
  before: ShownRows,
  after: ShownRows,
  moves: Moves,
  offset: number,
): { readonly key: string; readonly by: number } | null {
  if (offset <= 0) return null;
  const was = topsOf(before);
  // The row first in view: the last one that starts at or above where the list is scrolled.
  const first = before.rows.filter((row) => (was.get(row.key) ?? 0) <= offset).length - 1;
  const key = keptRow(keysOf(before).keys, keysOf(after).keys, moves, first);
  if (key === null) return null;
  const by = (topsOf(after).get(key) ?? 0) - (was.get(key) ?? 0);
  return by === 0 ? null : { key, by };
}

/**
 * How long the row `key` waits before it travels, in ms: a row already on its
 * way sets off again at once, and the others follow the rows that lift
 * (`moveDelay`). `null` for a row that does not move.
 */
export function travelDelay(
  { moves, moving }: Pick<RowMotion, "moves" | "moving">,
  key: string,
): number | null {
  const move = moves.get(key);
  if (move === undefined) return null;
  return moving.has(key) ? 0 : moveDelay(move, moves, lift.stepDelay);
}

/**
 * What the roster draws now that it shows `view`, after `drawn`: how each row
 * moves to its new place (`rosterMotion`), and how far the list's mark moves
 * with the row the list keeps in place, for a list scrolled to `offset`, or
 * on its way to where `drawn` was heading. Nothing moves on the first rows
 * drawn or when a search changed what is listed, and `null` is the roster not
 * shown. Under reduced motion no row travels, and the mark goes to its new
 * place at once, so the list still keeps its place.
 */
export function draw(
  drawn: Drawn,
  view: ShownRows | null,
  reduced: boolean,
  offset: number,
): Drawn {
  const before = drawn.view;
  const still = rested(drawn.motion);
  if (view === null || before === null) return { view, motion: still, heading: null };
  const moves = movesBetween(before, view);
  // Nothing moves, as after a search: nothing stays up either.
  if (moves.size === 0) return { view, motion: still, heading: null };
  const from = drawn.heading ?? offset;
  const kept = keptMove(before, view, moves, from);
  const top = drawn.motion.mark.top + (kept?.by ?? 0);
  const heading = kept === null ? drawn.heading : from + kept.by;
  if (reduced) return { view, motion: { ...still, mark: { top, delay: null } }, heading };
  const { keys } = keysOf(view);
  const shown = new Set(keys);
  const was = new Set(keysOf(before).keys);
  const lifting = [...moves].flatMap(([key, move]) => (lifts(move) ? [key] : []));
  const { motion } = drawn;
  const moving = new Set(
    [...motion.moving, ...motion.moves.keys()].filter((key) => shown.has(key)),
  );
  return {
    view,
    motion: {
      moves,
      lifted: new Set([...motion.lifted, ...lifting].filter((key) => shown.has(key))),
      moving,
      arrived: new Set(keys.filter((key) => !was.has(key))),
      mark: { top, delay: kept === null ? null : travelDelay({ moves, moving }, kept.key) },
    },
    heading,
  };
}
