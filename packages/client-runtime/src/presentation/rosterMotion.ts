// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How the roster's rows travel when its order changes. The order itself is
 * the roster's (`orderRoster`, `rosterRows`): this only says which rows move
 * and how, so every client draws a reorder the same way.
 */

/**
 * A row that changed place: `rise` and `sink` left the others' order, lift
 * off the list and travel; `step` keeps its place among the others and is
 * only pushed along, by a row that passed it or one that came or went.
 */
export type RowMove = "rise" | "sink" | "step";

/** The rows as one client shows them: their keys in order, and the search that chose them. */
export interface RosterView {
  readonly keys: ReadonlyArray<string>;
  readonly query: string;
}

interface Choice {
  readonly length: number;
  /** How far down the rows kept in place went, summed: a tie keeps the rows that sank. */
  readonly sank: number;
  readonly previous: number;
}

const better = (a: Choice, b: Choice) =>
  a.length !== b.length ? a.length > b.length : a.sank > b.sank;

/**
 * The rows that keep their order among themselves: the longest run of rows
 * whose old places still increase down the new order. Where several runs are
 * as long, the one that keeps the rows that went down, so that in a swap the
 * row that rose is the one that moved.
 */
function keptInOrder(oldRanks: ReadonlyArray<number>): ReadonlySet<number> {
  const choices: Choice[] = [];
  for (let i = 0; i < oldRanks.length; i++) {
    const sank = i - (oldRanks[i] ?? 0);
    let choice: Choice = { length: 1, sank, previous: -1 };
    for (let j = 0; j < i; j++) {
      const before = choices[j];
      if (before === undefined || (oldRanks[j] ?? 0) >= (oldRanks[i] ?? 0)) continue;
      const through: Choice = { length: before.length + 1, sank: before.sank + sank, previous: j };
      if (better(through, choice)) choice = through;
    }
    choices.push(choice);
  }
  let end = -1;
  choices.forEach((choice, i) => {
    const best = choices[end];
    if (best === undefined || better(choice, best)) end = i;
  });
  const kept = new Set<number>();
  for (let i = end; i !== -1; i = choices[i]?.previous ?? -1) kept.add(i);
  return kept;
}

/**
 * How each row moves from `before` to `after`, by key; rows that keep their
 * place are left out, as are rows that only came or went, which appear and
 * leave where they are. Several changes that land together, such as a burst
 * of bots speaking at once, are one move from the order last drawn.
 */
export function rosterMoves(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyMap<string, RowMove> {
  const stayed = new Set(after);
  const common = before.filter((key) => stayed.has(key));
  const was = new Map(common.map((key, rank) => [key, rank]));
  const now = after.filter((key) => was.has(key));
  const kept = keptInOrder(now.map((key) => was.get(key) ?? 0));
  const oldIndex = new Map(before.map((key, index) => [key, index]));
  const moves = new Map<string, RowMove>();
  now.forEach((key, rank) => {
    if (!kept.has(rank)) moves.set(key, rank < (was.get(key) ?? 0) ? "rise" : "sink");
  });
  after.forEach((key, index) => {
    const from = oldIndex.get(key);
    if (from !== undefined && from !== index && !moves.has(key)) moves.set(key, "step");
  });
  return moves;
}

/**
 * The moves to draw when the roster goes from `before` to `after`: none on
 * the first rows drawn, and none when the operator's own search changed what
 * is listed, where the results just appear.
 */
export const rosterMotion = (
  before: RosterView | null,
  after: RosterView,
): ReadonlyMap<string, RowMove> =>
  before === null || before.query !== after.query
    ? new Map()
    : rosterMoves(before.keys, after.keys);

/** Whether a row lifts off the list as it travels. */
export const lifts = (move: RowMove): boolean => move !== "step";

/**
 * Where each row starts in a list whose rows are `heights` tall, in order:
 * the sum of the heights above it.
 */
export const rowTops = (heights: ReadonlyArray<number>): ReadonlyArray<number> => {
  const tops: number[] = [];
  let top = 0;
  for (const height of heights) {
    tops.push(top);
    top += height;
  }
  return tops;
};

/**
 * Where a scrolled list keeps its place as its rows go from `before` to
 * `after`: for each place in `before`, how far the first row from there on
 * that stays listed and does not lift moved. The row first in view keeps
 * where it is on screen by the list scrolling that far, so rows moving above
 * the view do not push what the operator is looking at, and a row that lifts
 * away does not carry the view with it. Distances are in rows, or, for a list
 * whose rows differ in height, in what `tops` (`rowTops`) measures them in.
 */
export function keptPlaces(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  moves: ReadonlyMap<string, RowMove>,
  tops?: { readonly before: ReadonlyArray<number>; readonly after: ReadonlyArray<number> },
): ReadonlyArray<number> {
  const now = new Map(after.map((key, index) => [key, index]));
  const kept: number[] = [];
  let anchored = 0;
  for (let index = before.length - 1; index >= 0; index--) {
    const key = before[index] ?? "";
    const at = now.get(key);
    const move = moves.get(key);
    if (at !== undefined && (move === undefined || !lifts(move))) {
      anchored =
        tops === undefined ? at - index : (tops.after[at] ?? 0) - (tops.before[index] ?? 0);
    }
    kept[index] = anchored;
  }
  return kept;
}

/**
 * How long a row waits before it travels, in ms: the rows a lifted row passes
 * follow it `stepDelay` later; with no row lifted, every row goes at once.
 */
export const moveDelay = (
  move: RowMove,
  moves: ReadonlyMap<string, RowMove>,
  stepDelay: number,
): number => (move === "step" && [...moves.values()].some(lifts) ? stepDelay : 0);
