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

/** Where something on a spring is, and how fast it moves, per second. */
export interface SpringState {
  readonly x: number;
  readonly v: number;
}

/**
 * `state` after `seconds` on the spring of `frequency` and `damping`, pulled
 * toward `to`. It is the spring's own solution, not a sum of small steps, so
 * it draws the same motion at any frame rate and after any pause, and it
 * cannot run away. Retargeting is giving another `to`: the place and the speed
 * carry on, so a move interrupted mid-way bends into the next one. Everything
 * that can be interrupted moves through here: the avatars, the first run's
 * stage and the roster's rows on the web. A CSS easing (`Spring.easing`) is the
 * same spring sampled once, for moves nothing interrupts.
 *
 * A worklet, so the mobile app runs it on the UI thread. Every spring here
 * overshoots (damping under 1), which is the case this solves.
 */
export function springStep(
  state: SpringState,
  to: number,
  frequency: number,
  damping: number,
  seconds: number,
): SpringState {
  "worklet";
  const omega = 2 * Math.PI * frequency;
  const decay = damping * omega;
  const turn = omega * Math.sqrt(1 - damping * damping);
  const from = state.x - to;
  const swing = (state.v + decay * from) / turn;
  const fade = Math.exp(-decay * seconds);
  const cos = Math.cos(turn * seconds);
  const sin = Math.sin(turn * seconds);
  return {
    x: to + fade * (from * cos + swing * sin),
    v: fade * ((swing * turn - decay * from) * cos - (from * turn + decay * swing) * sin),
  };
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

/** The `out` ease's control points, for a platform that takes them as numbers, as Reanimated's `Easing.bezier` does. */
export const easeOutCurve = [0.2, 0.8, 0.2, 1] as const;

/** Eases for what a spring does not suit: fades, and moves with no end to overshoot. */
export const eases = {
  /** Fast out, long settle. */
  out: `cubic-bezier(${easeOutCurve.join(", ")})`,
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

/**
 * The stage: the first run and a bot's entrance into the roster, drawn the
 * same way by every surface. A dark floor, a spotlight per bot, and bots that
 * come down into the light and land with weight. Times are in ms, distances
 * in px unless said otherwise; each move names the spring or ease it travels
 * on where it is played.
 */
export const stage = {
  /**
   * A bot comes down from this many times its own height above its place. In
   * the air it falls as a thrown thing does (`avatarAir` in the client
   * runtime); on the ground it rides `pop`.
   */
  drop: 2,
  /** In a list it comes from just above its row, this many times its height, so it does not fall through the row above. */
  rowDrop: 0.9,
  /** The bots of one scene come down one after another, this far apart. */
  stagger: 140,
  /** A bot's spotlight comes on this long before the bot sets off, on the `out` ease over `spotIn`. */
  spotLead: 180,
  spotIn: 320,
  /** Text arrives out of focus: this blurred, this far below, clearing on `soft`. */
  focus: { blur: 10, rise: 14, gap: 90 },
  /** Text that leaves fades on the `out` ease in this long, so the next lines never wait for it. */
  leave: 160,
  /**
   * The camera: how much larger the stage is drawn when a scene is about one
   * bot, and how far it pulls back for the finale. It travels on `soft`.
   */
  close: 1.18,
  wide: 0.94,
  /** The finale's sweep of light crosses the stage in this long, on the `out` ease. */
  sweep: 1100,
  /** Once the first bot exists it grows by this share, on `pop`. */
  arrivalGrowth: 0.35,
  /**
   * Its rings start half a `pop` later, `gap` apart, and spread on the `out`
   * ease from 0.8 to `reach` times the grown bot as they fade.
   */
  rings: { count: 3, gap: 220, duration: 1400, reach: 1.9 },
  /** Its name pops in, then the line under it rises, this long after it starts to grow. */
  nameDelay: 260,
  lineDelay: 420,
  /** The arrival stays at least this long, so the bot is seen arriving before its conversation opens. */
  hold: 1900,
  /**
   * A bot or a room new to the roster: its row's light stays this long, and
   * its words come in this long after it sets off. More than `burst` new at
   * once, as when a roster loads again, simply appear.
   */
  rowLight: 1500,
  rowWords: 260,
  burst: 3,
  /** One that leaves the roster sinks and fades in this long, on the `out` ease. */
  rowLeave: 220,
} as const;
