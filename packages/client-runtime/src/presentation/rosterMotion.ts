// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How the roster's rows travel when its order changes. The order itself is
 * the roster's (`orderRoster`): this only says which rows move
 * and how, so every client draws a reorder the same way.
 */
import { stage } from "@j3-bots/design-tokens";

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
 * The row a scrolled list keeps where it is on screen as its rows go from
 * `before` to `after`: the first row from `first` on, the place in `before`
 * of the row first in view, that stays listed and does not lift. The list
 * scrolls as far as that row moves, so rows moving above the view do not push
 * what the operator is looking at, and a row that lifts away does not carry
 * the view with it. `null` when no row from there on stays.
 */
export function keptRow(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  moves: ReadonlyMap<string, RowMove>,
  first: number,
): string | null {
  const listed = new Set(after);
  const stays = (key: string) => {
    const move = moves.get(key);
    return listed.has(key) && (move === undefined || !lifts(move));
  };
  return before.slice(first).find(stays) ?? null;
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

/** Who the roster has listed so far, and who among them is new and still coming in. */
export interface RosterArrivals {
  /** Null until the roster has listed anyone: the first rows drawn are nobody's entrance. */
  readonly known: ReadonlySet<string> | null;
  readonly entering: ReadonlySet<string>;
}

/** Before the roster has listed anyone. */
export const noArrivals: RosterArrivals = { known: null, entering: new Set() };

/**
 * `arrivals` now that the roster lists `keys`, every bot and room it has, the
 * hidden ones too: whoever was not listed before is new and comes in with an
 * entrance, whoever made it. The roster's first rows are nobody's entrance,
 * and more than `burst` new at once, as when the roster is read again after a
 * while away, simply appear. The same object when nobody came or went.
 */
export function rosterArrivals(
  arrivals: RosterArrivals,
  keys: ReadonlyArray<string>,
  burst: number,
): RosterArrivals {
  const { known } = arrivals;
  if (known === null) return keys.length === 0 ? arrivals : { ...arrivals, known: new Set(keys) };
  const news = keys.filter((key) => !known.has(key));
  if (news.length === 0 && known.size === keys.length) return arrivals;
  return {
    known: new Set(keys),
    entering:
      news.length > 0 && news.length <= burst
        ? new Set([...arrivals.entering, ...news])
        : arrivals.entering,
  };
}

/**
 * The longest a row's arrival lasts, in ms (`stage`): its light's lead, the
 * longest it waits for its bot to land, and its light's hold and dimming.
 * Those entering are in once it has passed.
 */
export const ARRIVAL_LENGTH = stage.spotLead + stage.rowLand + stage.rowHold + stage.rowDim;

/** `arrivals` once those entering are in: rows like the others, which listed again just appear. */
export const arrivalsSettled = (arrivals: RosterArrivals): RosterArrivals =>
  arrivals.entering.size === 0 ? arrivals : { ...arrivals, entering: new Set() };
