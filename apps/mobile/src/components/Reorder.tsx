// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifts, rowTops } from "@j3-bots/client-runtime/presentation";
import { lift, motion as timing, reanimatedSpring, shadows, springs } from "@j3-bots/design-tokens";
import {
  type ComponentProps,
  type ComponentPropsWithRef,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type FlatListProps, ScrollView, type ScrollViewProps, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import type { RosterEntry } from "../screens/rosterEntries.ts";
import type { AvatarHandle } from "./avatar/BotAvatar.tsx";
import {
  draw,
  type ListedRow,
  type RowMotion,
  settled,
  type ShownRows,
  shows,
  taken,
  travelDelay,
  undrawn,
  unsettled,
} from "./rowMotion.ts";

type CellProps = ComponentProps<NonNullable<FlatListProps<RosterEntry>["CellRendererComponent"]>>;

/** Where each row of `rows` is in the list, for `getItemLayout`. */
export const rowLayout = (rows: ReadonlyArray<ListedRow>) => {
  const tops = rowTops(rows.map((row) => row.height));
  return (_: unknown, index: number) => ({
    length: rows[index]?.height ?? 0,
    offset: tops[index] ?? 0,
    index,
  });
};

/** How far the roster's list is scrolled, in px, as it last said. */
export interface ListScroll {
  readonly at: () => number;
  readonly to: (offset: number) => void;
}

/** A list at the top, until it says where it is scrolled. */
export function listScroll(): ListScroll {
  let offset = 0;
  return {
    at: () => offset,
    to: (next) => {
      offset = next;
    },
  };
}

/**
 * How each row moves now that the roster shows `view` (`draw`): set in the
 * render that changes the order, so each row's transition, and the mark's
 * (`KeptScroll`), is in place when the list moves it, and cleared once the
 * rows have settled. `null` while the roster is not shown, after which its
 * rows appear where they are. `scroll` is read as the order changes, to tell
 * which row is first in view. Under reduced motion no row moves, and the list
 * still keeps its place. Also returns what the list calls when the operator
 * takes it.
 */
export function useRowMotion(
  view: ShownRows | null,
  scroll: ListScroll,
): { readonly motion: RowMotion; readonly onTaken: () => void } {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState(undrawn);
  if (!shows(drawn, view)) setDrawn(draw(drawn, view, reduced, scroll.at()));
  useEffect(() => {
    if (!unsettled(drawn)) return;
    const settling = setTimeout(
      () => setDrawn((now) => (now === drawn ? settled(now) : now)),
      springs.slide.duration + lift.stepDelay,
    );
    return () => clearTimeout(settling);
  }, [drawn]);
  const onTaken = useCallback(() => setDrawn(taken), []);
  return { motion: drawn.motion, onTaken };
}

const slide = reanimatedSpring(springs.slide);
const soft = reanimatedSpring(springs.soft);

/** The rows' motion, the rows on their way out, and those that bring themselves in. */
const MotionNow = createContext<{
  readonly motion: RowMotion;
  readonly leaving: ReadonlySet<string>;
  readonly entering: ReadonlySet<string>;
}>({ motion: undrawn.motion, leaving: new Set(), entering: new Set() });

/**
 * Gives the list below how each of its rows moves, and which rows leave the
 * list by the operator's own hand, as a bot pinned or moved behind the scenes: those fade away
 * as they go, where a row that only stops being listed, as after a search,
 * goes at once. A row `entering` comes in with an arrival of its own
 * (`RosterRow`), which the list does not fade in.
 */
export function RowMoves({
  motion,
  leaving,
  entering,
  children,
}: {
  readonly motion: RowMotion;
  readonly leaving: ReadonlySet<string>;
  readonly entering: ReadonlySet<string>;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ motion, leaving, entering }), [motion, leaving, entering]);
  return <MotionNow value={value}>{children}</MotionNow>;
}

/** A way to a new place on `slide`, after `delay` ms. */
const travel = (delay: number) =>
  LinearTransition.springify()
    .mass(slide.mass)
    .stiffness(slide.stiffness)
    .damping(slide.damping)
    .delay(delay);

/** At once, for a row that lifts or one already on its way; `lift.stepDelay` later, for the rows it passes. */
const ways = new Map([0, lift.stepDelay].map((delay) => [delay, travel(delay)]));

/** The way of what travels after `delay` ms, and none for what stays or goes at once. */
const wayAfter = (delay: number | null) => (delay === null ? undefined : ways.get(delay));

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
  const { motion, leaving, entering } = useContext(MotionNow);
  const reduced = useReducedMotion();
  const { moves, lifted, arrived } = motion;
  const move = moves.get(cellKey);
  const way = wayAfter(travelDelay(motion, cellKey));
  const above =
    move !== undefined && lifts(move) ? { zIndex: 2 } : lifted.has(cellKey) ? { zIndex: 1 } : null;
  return (
    <Animated.View
      {...(way === undefined ? {} : { layout: way })}
      {...(arrived.has(cellKey) && moves.size > 0 && !entering.has(cellKey)
        ? { entering: arriving }
        : {})}
      {...(leaving.has(cellKey) && !reduced ? { exiting: departing } : {})}
      style={[style, above]}
      onLayout={onLayout}
      onFocusCapture={onFocusCapture}
    >
      {children}
    </Animated.View>
  );
}

/** The scroll view holds the last thing in it where it is on screen: the mark, after the rows. */
const HOLDS_THE_MARK = { minIndexForVisible: 1 };

/**
 * The list's mark: nothing to see, only a place down the list, which travels
 * to its new place in the same transition as the row the list keeps in place.
 */
function KeptMark() {
  const { top, delay } = useContext(MotionNow).motion.mark;
  const way = wayAfter(delay);
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute start-0 size-0"
      {...(way === undefined ? {} : { layout: way })}
      style={{ top }}
    />
  );
}

/**
 * What the roster's list scrolls in (`renderScrollComponent`), which keeps
 * the list's place while it is scrolled. After the rows comes a mark, and the
 * scroll view holds the mark where it is on screen
 * (`maintainVisibleContentPosition`): as it mounts a frame that moved the
 * mark down the list, it scrolls that far, before the frame is drawn. The
 * mark moves as far as the first row in view that does not lift (`draw`), in
 * a transition of the same spring, started with the rows' own, and Reanimated
 * mounts every transition's frame in one go. So that row holds still: rows
 * moving above the view do not push what the operator is looking at, and the
 * rows below close up. The list never scrolls itself to keep its place, so no
 * scroll reaches the screen apart from the rows. Under reduced motion the
 * mark goes to its place at once, in the frame the rows do.
 */
function KeptScroll({ children, ...props }: ComponentPropsWithRef<typeof ScrollView>) {
  return (
    <ScrollView {...props} maintainVisibleContentPosition={HOLDS_THE_MARK}>
      <View>{children}</View>
      <KeptMark />
    </ScrollView>
  );
}

/** The roster's list scrolls in a `KeptScroll`. */
export const keptScroll = (props: ScrollViewProps) => <KeptScroll {...props} />;

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
