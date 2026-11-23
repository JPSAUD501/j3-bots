// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The springs every surface moves on. A spring is named by its natural
 * frequency (Hz) and damping ratio, so the web and the phone can draw the same
 * motion from the same two numbers: the web as a CSS `linear()` easing over the
 * time the spring takes to settle, the phone as a Reanimated spring with the
 * same stiffness and damping.
 *
 * The reasoning behind the values is in docs/design/design-language.md#motion.
 */

/** A damped spring from 0 to 1, as each platform draws it. */
export interface Spring {
  /** Natural frequency, in Hz. */
  readonly frequency: number;
  /** Damping ratio: below 1 it overshoots, at 1 it does not. */
  readonly damping: number;
  /** The spring's path as a CSS easing, sampled about 60 times a second. */
  readonly easing: string;
  /** How long it takes to come to rest, in ms: the duration that goes with `easing`. */
  readonly duration: number;
}

/** Reanimated's physical spring (`withSpring`), for a unit mass. */
export interface ReanimatedSpring {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}

/** Where a spring counts as at rest: this close to its target and this slow. */
const REST_DISTANCE = 0.003;
const REST_SPEED = 0.03;
/** No spring here runs longer than this, in seconds. */
const LONGEST = 3;
/** The rate the settle time is measured at, and the rate `linear()` is sampled at, per second. */
const MEASURE_RATE = 240;
const SAMPLE_RATE = 60;
const FEWEST_POINTS = 14;
const MOST_POINTS = 90;

interface State {
  position: number;
  velocity: number;
}

/** Moves a spring toward 1 for `seconds`, in steps short enough to stay stable. */
function advance(state: State, frequency: number, damping: number, seconds: number): void {
  const omega = 2 * Math.PI * frequency;
  const steps = Math.max(1, Math.ceil(seconds / 0.006));
  const h = seconds / steps;
  for (let i = 0; i < steps; i++) {
    const acceleration =
      -omega * omega * (state.position - 1) - 2 * damping * omega * state.velocity;
    state.velocity += acceleration * h;
    state.position += state.velocity * h;
  }
}

/** Seconds until a spring from 0 comes to rest at 1. */
export function settleTime(frequency: number, damping: number): number {
  const state: State = { position: 0, velocity: 0 };
  const dt = 1 / MEASURE_RATE;
  let t = 0;
  while (t < LONGEST) {
    advance(state, frequency, damping, dt);
    t += dt;
    if (
      t > 0.1 &&
      Math.abs(state.position - 1) < REST_DISTANCE &&
      Math.abs(state.velocity) < REST_SPEED
    ) {
      break;
    }
  }
  return t;
}

/** The spring's position at `points + 1` even steps over `seconds`, the last one exactly 1. */
export function springPath(frequency: number, damping: number, seconds: number): number[] {
  const points = Math.min(MOST_POINTS, Math.max(FEWEST_POINTS, Math.round(seconds * SAMPLE_RATE)));
  const state: State = { position: 0, velocity: 0 };
  const path: number[] = [];
  for (let i = 0; i <= points; i++) {
    path.push(Number(state.position.toFixed(3)));
    advance(state, frequency, damping, seconds / points);
  }
  path[points] = 1;
  return path;
}

export function spring(frequency: number, damping: number): Spring {
  const seconds = settleTime(frequency, damping);
  return {
    frequency,
    damping,
    easing: `linear(${springPath(frequency, damping, seconds).join(", ")})`,
    duration: Math.round(seconds * 1000),
  };
}

/** The same spring for Reanimated: stiffness ω² and damping 2ζω, for a mass of 1. */
export function reanimatedSpring({ frequency, damping }: Spring): ReanimatedSpring {
  const omega = 2 * Math.PI * frequency;
  return { mass: 1, stiffness: omega * omega, damping: 2 * damping * omega };
}

export const springs = {
  /** Quick, with a visible overshoot: a press springing back, a message arriving, a toggle. */
  pop: spring(3.6, 0.5),
  /** Slower and gentler: something moving into place, such as a panel's content. */
  soft: spring(2.3, 0.72),
  /** Almost no overshoot: a pane or sheet sliding, a fold opening. */
  slide: spring(2.5, 0.86),
} as const;

/** Eases for what a spring does not suit: fades, and moves with no end to overshoot. */
export const eases = {
  /** Fast out, long settle. */
  out: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

/** Press feedback: what a pressed control scales to, and how fast it goes down. It comes back on `pop`. */
export const press = {
  scale: 0.955,
  /** A round icon button, which is small enough to take a deeper press. */
  roundScale: 0.88,
  /** A row as wide as a list, where a deep press would move its edges too far. */
  rowScale: 0.975,
  /** ms */
  duration: 70,
} as const;

/**
 * A roster row that changes place lifts off the list while it travels: a
 * little larger, over a soft shadow (`shadows.lift`). The rows it passes
 * step aside `stepDelay` ms after it sets off. Both travel on `slide`.
 */
export const lift = {
  scale: 1.02,
  /** ms */
  stepDelay: 40,
} as const;
