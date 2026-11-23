// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  keptPlaces,
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
  rowTops,
} from "@j3-bots/client-runtime/presentation";
import { lift, motion as timing, reanimatedSpring, shadows, springs } from "@j3-bots/design-tokens";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type FlatList, type FlatListProps, View } from "react-native";
import Animated, {
  type AnimatedRef,
  cancelAnimation,
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  LinearTransition,
  type SharedValue,
  scrollTo,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import type { RosterEntry } from "../screens/rosterEntries.ts";
import type { AvatarHandle } from "./avatar/BotAvatar.tsx";

type Moves = ReadonlyMap<string, RowMove>;

type CellProps = ComponentProps<NonNullable<FlatListProps<RosterEntry>["CellRendererComponent"]>>;

/** A row the list shows: its key, and the height it takes, known without measuring it. */
type ListedRow = Pick<RosterEntry, "key" | "height">;

/** The rows as the roster shows them, and the search that chose them. */
interface ShownRows {
  readonly rows: ReadonlyArray<ListedRow>;
  readonly query: string;
}

/** Where each row of `rows` is in the list, for `getItemLayout`. */
export const rowLayout = (rows: ReadonlyArray<ListedRow>) => {
  const tops = rowTops(rows.map((row) => row.height));
  return (_: unknown, index: number) => ({
    length: rows[index]?.height ?? 0,
    offset: tops[index] ?? 0,
    index,
  });
};

/** How the roster's rows move in the order now drawn. */
interface RowMotion {
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
  /** Where the list keeps its place while scrolled, under reduced motion too. */
  readonly kept: KeptPlace;
  /** Which order this is, counted up, so the list keeps its place once for each. */
  readonly order: number;
}

/**
 * How far the list scrolls to keep its place (`keptPlaces`), in px, for each
 * row it showed before, and where each of those rows started.
 */
interface KeptPlace {
  readonly shifts: ReadonlyArray<number>;
  readonly from: ReadonlyArray<number>;
}

const keptNowhere: KeptPlace = { shifts: [], from: [] };

const atRest: RowMotion = {
  moves: new Map(),
  lifted: new Set(),
  moving: new Set(),
  arrived: new Set(),
  kept: keptNowhere,
  order: 0,
};

const sameView = (a: ShownRows, b: ShownRows) =>
  a.query === b.query &&
  a.rows.length === b.rows.length &&
  a.rows.every(
    (row, index) => row.key === b.rows[index]?.key && row.height === b.rows[index]?.height,
  );

const keysOf = (view: ShownRows): RosterView => ({
  keys: view.rows.map((row) => row.key),
  query: view.query,
});

/**
 * The moves from `before` to `after` (`rosterMotion`), and with them every
 * row that stays in order but starts somewhere else, as the rows under a band
 * that grew: each steps to its new place too.
 */
function movesBetween(before: ShownRows | null, after: ShownRows): ReadonlyMap<string, RowMove> {
  const moves = rosterMotion(before === null ? null : keysOf(before), keysOf(after));
  if (before === null || before.query !== after.query) return moves;
  const tops = (view: ShownRows) => {
    const at = rowTops(view.rows.map((row) => row.height));
    return new Map(view.rows.map((row, index) => [row.key, at[index] ?? 0]));
  };
  const was = tops(before);
  const now = tops(after);
  const shifted = [...now].filter(([key, top]) => !moves.has(key) && (was.get(key) ?? top) !== top);
  if (shifted.length === 0) return moves;
  return new Map([...moves, ...shifted.map(([key]) => [key, "step"] as const)]);
}

interface Drawn {
  readonly view: ShownRows | null;
  readonly motion: RowMotion;
  /** How many motions were drawn, the one at rest included. */
  readonly count: number;
}

/** The motion from the order drawn with `drawn` to `view`. */
function nextMotion(drawn: Drawn, view: ShownRows, reduced: boolean): RowMotion {
  const before = drawn.view;
  const moves = movesBetween(before, view);
  // Nothing moves, as after a search: nothing stays up either.
  if (before === null || moves.size === 0) return atRest;
  const order = drawn.count + 1;
  const from = rowTops(before.rows.map((row) => row.height));
  const shifts = keptPlaces(keysOf(before).keys, keysOf(view).keys, moves, {
    before: from,
    after: rowTops(view.rows.map((row) => row.height)),
  });
  const kept = { shifts, from };
  if (reduced) return { ...atRest, kept, order };
  const keys = keysOf(view).keys;
  const shown = new Set(keys);
  const was = new Set(keysOf(before).keys);
  const lifting = [...moves].flatMap(([key, move]) => (lifts(move) ? [key] : []));
  const { motion } = drawn;
  return {
    moves,
    lifted: new Set([...motion.lifted, ...lifting].filter((key) => shown.has(key))),
    moving: new Set([...motion.moving, ...motion.moves.keys()].filter((key) => shown.has(key))),
    arrived: new Set(keys.filter((key) => !was.has(key))),
    kept,
    order,
  };
}

/**
 * How each row moves now that the roster shows `view` (`rosterMotion`): set
 * in the render that changes the order, so each row's transition is in place
 * when the list moves it, and cleared once the rows have settled. `null`
 * while the roster is not shown, after which its rows appear where they are.
 * Under reduced motion no row moves, and the list still keeps its place.
 */
export function useRowMotion(view: ShownRows | null): RowMotion {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState<Drawn>({ view: null, motion: atRest, count: 0 });
  if (view === null ? drawn.view !== null : drawn.view === null || !sameView(drawn.view, view)) {
    setDrawn({
      view,
      motion: view === null ? atRest : nextMotion(drawn, view, reduced),
      count: drawn.count + 1,
    });
  }
  useEffect(() => {
    if (drawn.motion.moves.size === 0) return;
    const settled = setTimeout(
      () =>
        setDrawn((now) => (now === drawn ? { ...now, motion: atRest, count: now.count + 1 } : now)),
      springs.slide.duration + lift.stepDelay,
    );
    return () => clearTimeout(settled);
  }, [drawn]);
  return drawn.motion;
}

/**
 * How far the list scrolls to keep its place, in px, from `offset`, where it
 * is scrolled: the shift kept for the last row that started at or above it.
 * At the top it stays at the top, where a row that rises comes into view.
 */
function keptShift({ shifts, from }: KeptPlace, offset: number): number {
  "worklet";
  if (offset <= 0) return 0;
  let shift = 0;
  for (let index = 0; index < from.length && (from[index] ?? 0) <= offset; index++) {
    shift = shifts[index] ?? 0;
  }
  return shift;
}

const slide = reanimatedSpring(springs.slide);
const soft = reanimatedSpring(springs.soft);

/** Where the list is gliding to, to keep its place, or `null` while it is not. */
type Heading = number | null;

/** What keeps the list's place, read and moved on the UI thread. */
interface Keeper {
  readonly list: AnimatedRef<FlatList<RosterEntry>>;
  /** The offset the list glides through. */
  readonly scroll: SharedValue<number>;
  readonly heading: SharedValue<Heading>;
  /** How far the list is scrolled, as it last said. */
  readonly scrolled: SharedValue<number>;
  /** The last order the list kept its place for. */
  readonly keptFor: SharedValue<number>;
}

/** The rows' motion, what keeps the list's place as they move, and the rows on their way out. */
const MotionNow = createContext<{
  readonly motion: RowMotion;
  readonly keeper: Keeper | null;
  readonly leaving: ReadonlySet<string>;
}>({ motion: atRest, keeper: null, leaving: new Set() });

/**
 * Keeps the list's place for `motion`, once (`keptPlaces`): it glides on
 * `slide`, after `delay` ms, from wherever it is scrolled or still gliding to,
 * or, with no rows moving, as under reduced motion, it goes there at once.
 */
function keepPlace(keeper: Keeper, kept: KeptPlace, order: number, delay: number) {
  "worklet";
  if (keeper.keptFor.get() === order) return;
  keeper.keptFor.set(order);
  const { list, scroll, heading, scrolled } = keeper;
  const gliding = heading.get();
  const from = gliding ?? scrolled.get();
  const shift = keptShift(kept, from);
  if (shift === 0) return;
  const to = from + shift;
  if (delay < 0) {
    cancelAnimation(scroll);
    heading.set(null);
    scrollTo(list, 0, to, false);
    return;
  }
  if (gliding === null) scroll.set(scrolled.get());
  heading.set(to);
  scroll.set(
    withDelay(
      delay,
      withSpring(to, slide, (finished) => {
        if (finished === true) heading.set(null);
      }),
    ),
  );
}

/**
 * While the list is scrolled, keeps the first row in view that does not lift
 * where it is on screen as the order changes. The rows travel to their new
 * places in the list, and the list glides as far as that row moved, on the same
 * `slide`, started by the rows' own transitions (`ReorderCell`) in the frame they
 * start: rows moving above the view do not push what the operator is looking
 * at, and the rows below close up. The scroll reaches the screen apart from the
 * rows' transitions, so that row can shake by a frame's travel. Under reduced
 * motion the list goes to its place at once. Returns what stops the glide, for
 * when the operator takes the list.
 */
export function useKeptPlace(
  list: AnimatedRef<FlatList<RosterEntry>>,
  { moves, kept, order }: RowMotion,
  scrolled: SharedValue<number>,
): { readonly keeper: Keeper; readonly stop: () => void } {
  const scroll = useSharedValue(0);
  const heading = useSharedValue<Heading>(null);
  const keptOrder = useSharedValue(0);
  const keeper = useMemo(
    () => ({ list, scroll, heading, scrolled, keptFor: keptOrder }),
    [list, scroll, heading, scrolled, keptOrder],
  );
  useAnimatedReaction(
    () => (heading.get() === null ? null : scroll.get()),
    (offset) => {
      if (offset !== null) scrollTo(list, 0, offset, false);
    },
  );
  useLayoutEffect(() => {
    // With rows moving, the rows' transitions start the glide.
    if (kept.shifts.length === 0 || moves.size > 0) return;
    scheduleOnUI(keepPlace, keeper, kept, order, -1);
  }, [keeper, kept, moves, order]);
  const stop = useCallback(() => {
    cancelAnimation(scroll);
    heading.set(null);
  }, [scroll, heading]);
  return { keeper, stop };
}

/**
 * Gives the rows below how each of them moves, what keeps the list's place,
 * and which rows leave the list by the operator's own hand, as a bot pinned
 * or hidden: those fade away as they go, where a row that only stops being
 * listed, as after a search, goes at once.
 */
export function RowMoves({
  motion,
  keeper,
  leaving,
  children,
}: {
  readonly motion: RowMotion;
  readonly keeper: Keeper;
  readonly leaving: ReadonlySet<string>;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ motion, keeper, leaving }), [motion, keeper, leaving]);
  return <MotionNow value={value}>{children}</MotionNow>;
}

/** A row's way to its new place on `slide`, after `delay` ms. */
const travel = (delay: number) =>
  LinearTransition.springify()
    .mass(slide.mass)
    .stiffness(slide.stiffness)
    .damping(slide.damping)
    .delay(delay);

/** At once, for a row that lifts or one already on its way; `lift.stepDelay` later, for the rows it passes. */
const ways = new Map([0, lift.stepDelay].map((delay) => [delay, travel(delay)]));

/**
 * A moved row's way, which also starts the list's glide to keep its place:
 * Reanimated starts every moved row's transition in the frame the rows move,
 * so the glide starts with them, whichever row comes first.
 */
const keeping =
  (
    way: LayoutAnimationFunction,
    keeper: Keeper,
    kept: KeptPlace,
    order: number,
    delay: number,
  ): LayoutAnimationFunction =>
  (values) => {
    "worklet";
    keepPlace(keeper, kept, order, delay);
    return way(values);
  };

/** A row new to the list, fading in on `soft`. */
const arriving = FadeIn.springify().mass(soft.mass).stiffness(soft.stiffness).damping(soft.damping);

/** A row the operator moved out of the list, fading away on `out` as the rows under it close up. */
const departing = FadeOut.duration(timing.state);

/**
 * The list's cell for a roster row: it travels to the row's new place when
 * the order changes, on the UI thread, from wherever it is drawn, so a burst
 * retargets it. The row the latest move lifted passes over the others, and
 * over a row still up from a move before.
 */
export function ReorderCell({ cellKey, children, style, onLayout, onFocusCapture }: CellProps) {
  const { motion, keeper, leaving } = useContext(MotionNow);
  const reduced = useReducedMotion();
  const { moves, lifted, moving, arrived, kept, order } = motion;
  const move = moves.get(cellKey);
  // A row already on its way sets off again at once; the others follow the rows that lift.
  const delay =
    move === undefined ? null : moving.has(cellKey) ? 0 : moveDelay(move, moves, lift.stepDelay);
  const travelling = delay === null ? undefined : ways.get(delay);
  // The row kept in place steps with the rows a lifted row passes, so the list glides with it.
  const way =
    travelling === undefined || keeper === null || kept.shifts.length === 0
      ? travelling
      : keeping(travelling.build(), keeper, kept, order, moveDelay("step", moves, lift.stepDelay));
  const above =
    move !== undefined && lifts(move) ? { zIndex: 2 } : lifted.has(cellKey) ? { zIndex: 1 } : null;
  return (
    <Animated.View
      {...(way === undefined ? {} : { layout: way })}
      {...(arrived.has(cellKey) && moves.size > 0 ? { entering: arriving } : {})}
      {...(leaving.has(cellKey) && !reduced ? { exiting: departing } : {})}
      style={[style, above]}
      onLayout={onLayout}
      onFocusCapture={onFocusCapture}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A roster row that lifts while it travels: a little larger, over an opaque
 * ground with the lift shadow, set down again as it arrives. A row that
 * rose makes its bot hop. A row a burst moves again stays up and does not
 * hop twice.
 */
export function RowLift({
  rowKey,
  selected,
  children,
}: {
  readonly rowKey: string;
  /** Its ground is the selected row's fill. */
  readonly selected: boolean;
  /** The row, given what makes its avatar move. */
  readonly children: (avatar: RefObject<AvatarHandle | null>) => ReactNode;
}) {
  const { moves, lifted } = useContext(MotionNow).motion;
  const avatar = useRef<AvatarHandle>(null);
  const raised = useSharedValue(0);
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  // Each new order is a new `moves`, so a row that moves again is lifted again.
  useEffect(() => {
    const move = moves.get(rowKey);
    if (move !== undefined && lifts(move)) {
      if (move === "rise" && raised.get() === 0) avatar.current?.poke("hop");
      raised.set(withSpring(1, soft));
    } else if (raised.get() === 0) {
      return;
    }
    // Set down as the row arrives: its way on `slide` ends then. A row still up that a new
    // order only pushes along arrives at its new place on that order's way.
    const settling = setTimeout(() => raised.set(withSpring(0, soft)), springs.slide.duration);
    return () => clearTimeout(settling);
  }, [moves, rowKey, raised]);
  const scaled = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (lift.scale - 1) * raised.get() }],
  }));
  // The ground is drawn in the same commit as the row's way, so the rows it passes never show
  // through it, even in the first frames; only its shadow comes and goes with the lift.
  const shadow = useAnimatedStyle(() => ({ opacity: raised.get() }));
  return (
    <Animated.View style={scaled}>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-y-0 inset-x-2 rounded-lg"
        style={[{ boxShadow: shadows.lift[theme] }, shadow]}
      />
      {lifted.has(rowKey) && (
        <View
          pointerEvents="none"
          className={`absolute inset-y-0 inset-x-2 rounded-lg ${selected ? "bg-muted" : "bg-background"}`}
        />
      )}
      {children(avatar)}
    </Animated.View>
  );
}
