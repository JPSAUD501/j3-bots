// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  keptPlaces,
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
} from "@j3-bots/client-runtime/presentation";
import type { RosterItem } from "@j3-bots/contracts";
import { layout, lift, reanimatedSpring, shadows, springs } from "@j3-bots/design-tokens";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type FlatList, type FlatListProps, View } from "react-native";
import Animated, {
  FadeIn,
  type LayoutAnimationFunction,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import type { AvatarHandle } from "./avatar/BotAvatar.tsx";

type Moves = ReadonlyMap<string, RowMove>;

type CellProps = ComponentProps<NonNullable<FlatListProps<RosterItem>["CellRendererComponent"]>>;

/** Every roster row is this tall, so the list knows where each row is without measuring it. */
export const ROW_HEIGHT = layout.rowHeight.touch;

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
  /** Where the list keeps its place while scrolled (`keptPlaces`), under reduced motion too. */
  readonly kept: ReadonlyArray<number>;
}

const atRest: RowMotion = {
  moves: new Map(),
  lifted: new Set(),
  moving: new Set(),
  arrived: new Set(),
  kept: [],
};

/** The rows' motion, and how far the list is scrolled, read on the UI thread. */
const MotionNow = createContext<{
  readonly motion: RowMotion;
  readonly scrolled: SharedValue<number> | null;
}>({ motion: atRest, scrolled: null });

const sameView = (a: RosterView, b: RosterView) =>
  a.query === b.query &&
  a.keys.length === b.keys.length &&
  a.keys.every((key, index) => key === b.keys[index]);

interface Drawn {
  readonly view: RosterView | null;
  readonly motion: RowMotion;
}

/** The motion from the order drawn with `drawn` to `view`. */
function nextMotion(drawn: Drawn, view: RosterView, reduced: boolean): RowMotion {
  const before = drawn.view;
  const moves = rosterMotion(before, view);
  // Nothing moves, as after a search: nothing stays up either.
  if (before === null || moves.size === 0) return atRest;
  const kept = keptPlaces(before.keys, view.keys, moves);
  if (reduced) return { ...atRest, kept };
  const shown = new Set(view.keys);
  const was = new Set(before.keys);
  const lifting = [...moves].flatMap(([key, move]) => (lifts(move) ? [key] : []));
  const { motion } = drawn;
  return {
    moves,
    lifted: new Set([...motion.lifted, ...lifting].filter((key) => shown.has(key))),
    moving: new Set([...motion.moving, ...motion.moves.keys()].filter((key) => shown.has(key))),
    arrived: new Set(view.keys.filter((key) => !was.has(key))),
    kept,
  };
}

/**
 * How each row moves now that the roster shows `view` (`rosterMotion`): set
 * in the render that changes the order, so each row's transition is in place
 * when the list moves it, and cleared once the rows have settled. `null`
 * while the roster is not shown, after which its rows appear where they are.
 * Under reduced motion no row moves, and the list still keeps its place.
 */
export function useRowMotion(view: RosterView | null): RowMotion {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState<Drawn>({ view: null, motion: atRest });
  if (view === null ? drawn.view !== null : drawn.view === null || !sameView(drawn.view, view)) {
    setDrawn({ view, motion: view === null ? atRest : nextMotion(drawn, view, reduced) });
  }
  useEffect(() => {
    if (drawn.motion.moves.size === 0) return;
    const settled = setTimeout(
      () => setDrawn((now) => (now === drawn ? { ...now, motion: atRest } : now)),
      springs.slide.duration + lift.stepDelay,
    );
    return () => clearTimeout(settled);
  }, [drawn]);
  return drawn.motion;
}

/**
 * How far the list scrolls to keep its place, in px, from `offset`, where it
 * is scrolled: at the top it stays at the top, where a row that rises comes
 * into view.
 */
function keptShift(kept: ReadonlyArray<number>, offset: number): number {
  "worklet";
  if (offset <= 0) return 0;
  return (kept[Math.floor(offset / ROW_HEIGHT)] ?? 0) * ROW_HEIGHT;
}

/**
 * While the list is scrolled, keeps the first row in view that does not lift
 * where it is on screen as the order changes, by scrolling as far as it
 * moved, so rows moving above the view do not push what the operator is
 * looking at.
 */
export function useKeptPlace(
  list: RefObject<FlatList<RosterItem> | null>,
  { kept }: RowMotion,
  scrolled: SharedValue<number>,
): void {
  useLayoutEffect(() => {
    const offset = scrolled.get();
    const shift = keptShift(kept, offset);
    if (shift !== 0) list.current?.scrollToOffset({ offset: offset + shift, animated: false });
  }, [list, kept, scrolled]);
}

/** Gives the rows below how each of them moves, and how far `scrolled` the list is. */
export function RowMoves({
  motion,
  scrolled,
  children,
}: {
  readonly motion: RowMotion;
  readonly scrolled: SharedValue<number>;
  readonly children: ReactNode;
}) {
  return <MotionNow value={{ motion, scrolled }}>{children}</MotionNow>;
}

const slide = reanimatedSpring(springs.slide);
const soft = reanimatedSpring(springs.soft);

/**
 * A row's way to its new place on `slide`, after `delay` ms, from where it is
 * drawn: from its place a moment ago, less however far the list scrolls in
 * the same commit to keep its place, so the row sets off from where it
 * showed.
 */
const travel =
  (
    delay: number,
    kept: ReadonlyArray<number>,
    scrolled: SharedValue<number>,
  ): LayoutAnimationFunction =>
  (values) => {
    "worklet";
    const shift = keptShift(kept, scrolled.get());
    return {
      initialValues: {
        originX: values.currentOriginX,
        originY: values.currentOriginY + shift,
        width: values.currentWidth,
        height: values.currentHeight,
      },
      animations: {
        originX: withDelay(delay, withSpring(values.targetOriginX, slide)),
        originY: withDelay(delay, withSpring(values.targetOriginY, slide)),
        width: withDelay(delay, withSpring(values.targetWidth, slide)),
        height: withDelay(delay, withSpring(values.targetHeight, slide)),
      },
    };
  };

/**
 * Sets a row the order left in its place off from where it showed, when the
 * list scrolls under it to keep its place: by as far as the list scrolls,
 * back to none on `slide`.
 */
function scrolledUnder(
  nudge: SharedValue<number>,
  kept: ReadonlyArray<number>,
  scrolled: SharedValue<number>,
  delay: number,
): void {
  "worklet";
  const shift = keptShift(kept, scrolled.get());
  if (shift === 0) return;
  nudge.set(nudge.get() + shift);
  nudge.set(withDelay(delay, withSpring(0, slide)));
}

/** A row new to the list, fading in on `soft`. */
const arriving = FadeIn.springify().mass(soft.mass).stiffness(soft.stiffness).damping(soft.damping);

/**
 * The list's cell for a roster row: it travels to the row's new place when
 * the order changes, on the UI thread, from wherever it is drawn, so a burst
 * retargets it. The row the latest move lifted passes over the others, and
 * over a row still up from a move before.
 */
export function ReorderCell({ cellKey, children, style, onLayout, onFocusCapture }: CellProps) {
  const { motion, scrolled } = useContext(MotionNow);
  const { moves, lifted, moving, arrived, kept } = motion;
  const move = moves.get(cellKey);
  // A row already on its way sets off again at once; the others follow the rows that lift.
  const delay = moving.has(cellKey) ? 0 : moveDelay(move ?? "step", moves, lift.stepDelay);
  const way = useMemo(
    () => (move === undefined || scrolled === null ? undefined : travel(delay, kept, scrolled)),
    [move, delay, kept, scrolled],
  );
  const nudge = useSharedValue(0);
  useLayoutEffect(() => {
    if (move !== undefined || moves.size === 0 || arrived.has(cellKey) || scrolled === null) return;
    scheduleOnUI(scrolledUnder, nudge, kept, scrolled, delay);
  }, [move, moves, arrived, cellKey, scrolled, nudge, kept, delay]);
  const nudged = useAnimatedStyle(() => ({ transform: [{ translateY: nudge.get() }] }));
  const above =
    move !== undefined && lifts(move) ? { zIndex: 2 } : lifted.has(cellKey) ? { zIndex: 1 } : null;
  return (
    <Animated.View
      {...(way === undefined ? {} : { layout: way })}
      {...(arrived.has(cellKey) && moves.size > 0 ? { entering: arriving } : {})}
      style={[style, above, nudged]}
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
