// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
} from "@j3-bots/client-runtime/presentation";
import type { RosterItem } from "@j3-bots/contracts";
import { lift, reanimatedSpring, shadows, springs } from "@j3-bots/design-tokens";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type FlatListProps, View } from "react-native";
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useUniwind } from "uniwind";
import { useReducedMotion } from "../motion.ts";
import type { AvatarHandle } from "./avatar/BotAvatar.tsx";

type Moves = ReadonlyMap<string, RowMove>;

type CellProps = ComponentProps<NonNullable<FlatListProps<RosterItem>["CellRendererComponent"]>>;

/** How the roster's rows move in the order now drawn. */
interface RowMotion {
  /** How each row moves, by key; none at rest. */
  readonly moves: Moves;
  /**
   * The rows up off the list: each row a move lifted, until the rows settle, so
   * a row a burst only pushes along stays up until it arrives.
   */
  readonly lifted: ReadonlySet<string>;
}

const atRest: RowMotion = { moves: new Map(), lifted: new Set() };

const MotionNow = createContext<RowMotion>(atRest);

const sameView = (a: RosterView, b: RosterView) =>
  a.query === b.query &&
  a.keys.length === b.keys.length &&
  a.keys.every((key, index) => key === b.keys[index]);

interface Drawn {
  readonly view: RosterView | null;
  readonly motion: RowMotion;
}

/** The motion from the order drawn with `drawn` to `view`. */
function nextMotion(drawn: Drawn, view: RosterView): RowMotion {
  const moves = rosterMotion(drawn.view, view);
  // Nothing moves, as after a search: nothing stays up either.
  if (moves.size === 0) return atRest;
  const shown = new Set(view.keys);
  const lifting = [...moves].flatMap(([key, move]) => (lifts(move) ? [key] : []));
  return {
    moves,
    lifted: new Set([...drawn.motion.lifted, ...lifting].filter((key) => shown.has(key))),
  };
}

/**
 * How each row moves now that the roster shows `view` (`rosterMotion`): set
 * in the render that changes the order, so each row's transition is in place
 * when the list moves it, and cleared once the rows have settled. `null`
 * while the roster is not shown, after which its rows appear where they are.
 */
export function useRowMotion(view: RosterView | null): RowMotion {
  const [drawn, setDrawn] = useState<Drawn>({ view: null, motion: atRest });
  if (view === null ? drawn.view !== null : drawn.view === null || !sameView(drawn.view, view)) {
    setDrawn({ view, motion: view === null ? atRest : nextMotion(drawn, view) });
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

/** Gives the rows below how each of them moves. */
export function RowMoves({
  motion,
  children,
}: {
  readonly motion: RowMotion;
  readonly children: ReactNode;
}) {
  return <MotionNow value={motion}>{children}</MotionNow>;
}

const slide = reanimatedSpring(springs.slide);

/** A row's way to its new place on `slide`, after `delay` ms. */
const travel = (delay: number) =>
  LinearTransition.springify()
    .mass(slide.mass)
    .stiffness(slide.stiffness)
    .damping(slide.damping)
    .delay(delay);

/** At once, for a row that lifts; `lift.stepDelay` later, for the rows it passes. */
const ways = new Map([0, lift.stepDelay].map((delay) => [delay, travel(delay)]));

/**
 * The list's cell for a roster row: it travels to the row's new place when
 * the order changes, on the UI thread, from wherever it is drawn, so a burst
 * retargets it. A lifted row passes over the others.
 */
export function ReorderCell({ cellKey, children, style, onLayout, onFocusCapture }: CellProps) {
  const { moves, lifted } = useContext(MotionNow);
  const move = moves.get(cellKey);
  // Under reduced motion the rows take their places at once, the rows a lifted one passes too.
  const reduced = useReducedMotion();
  const way =
    move === undefined || reduced ? undefined : ways.get(moveDelay(move, moves, lift.stepDelay));
  return (
    <Animated.View
      {...(way === undefined ? {} : { layout: way })}
      style={[style, lifted.has(cellKey) && !reduced ? { zIndex: 1 } : null]}
      onLayout={onLayout}
      onFocusCapture={onFocusCapture}
    >
      {children}
    </Animated.View>
  );
}

const soft = reanimatedSpring(springs.soft);

/**
 * A roster row that lifts while it travels: a little larger, over an opaque
 * ground with the lift shadow, set down again as it arrives. A row that
 * rose makes its bot hop. A row a burst moves again stays up and does not
 * hop twice. Reduced motion keeps it flat.
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
  const { moves, lifted } = useContext(MotionNow);
  const reduced = useReducedMotion();
  const avatar = useRef<AvatarHandle>(null);
  const raised = useSharedValue(0);
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  // Each new order is a new `moves`, so a row that moves again is lifted again.
  useEffect(() => {
    const move = moves.get(rowKey);
    if (move !== undefined && lifts(move) && !reduced) {
      if (move === "rise" && raised.get() === 0) avatar.current?.poke("hop");
      raised.set(withSpring(1, soft));
    } else if (raised.get() === 0) {
      return;
    }
    // Set down as the row arrives: its way on `slide` ends then. A row still up that a new
    // order only pushes along arrives at its new place on that order's way.
    const arriving = setTimeout(() => raised.set(withSpring(0, soft)), springs.slide.duration);
    return () => clearTimeout(arriving);
  }, [moves, rowKey, reduced, raised]);
  const scaled = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (lift.scale - 1) * raised.get() }],
  }));
  // The ground is drawn in the same commit as the row's way, so the rows it passes never show
  // through it, even in the first frames; only its shadow comes and goes with the lift.
  const grounded = !reduced && lifted.has(rowKey);
  const shadow = useAnimatedStyle(() => ({ opacity: raised.get() }));
  return (
    <Animated.View style={scaled}>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-y-0 inset-x-2 rounded-lg"
        style={[{ boxShadow: shadows.lift[theme] }, shadow]}
      />
      {grounded && (
        <View
          pointerEvents="none"
          className={`absolute inset-y-0 inset-x-2 rounded-lg ${selected ? "bg-muted" : "bg-background"}`}
        />
      )}
      {children(avatar)}
    </Animated.View>
  );
}
