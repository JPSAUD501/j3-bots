// SPDX-License-Identifier: AGPL-3.0-or-later
import { springs, springStep, type SpringState } from "@j3-bots/design-tokens";
import { drive, reducedMotion } from "../components/avatar/ticker";

type SpringName = keyof typeof springs;

/** Where a value counts as arrived: this close to its target, in its own units, and this slow. */
const REST = { distance: 0.01, speed: 0.05 } as const;

interface Channel {
  state: SpringState;
  to: number;
  spring: SpringName;
  /** Seconds it still waits before it sets off. */
  wait: number;
}

/** How a value travels to a new target. */
interface Travel {
  /** The spring it rides; the one it rode before when left out. */
  readonly spring?: SpringName;
  /** How long it waits before setting off, in ms. */
  readonly delay?: number;
}

/**
 * A few numbers that travel to their targets on the interface's springs, on
 * the page's frame loop, for whatever can be interrupted mid-way: a new target
 * bends the move from where it is and at the speed it has, where a CSS
 * transition would stop it dead and start again. `write` draws them, once a
 * frame while any of them moves; keep it to transforms and opacity.
 *
 * Under reduced motion every value is at its target at once.
 */
export interface Sprung<K extends string> {
  /** Sends the values named to new targets. */
  readonly to: (targets: Partial<Record<K, number>>, travel?: Travel) => void;
  /** Puts the values named where given, at rest there: where something starts from. */
  readonly jump: (values: Partial<Record<K, number>>) => void;
  /**
   * Moves the values named by this much without touching their speed or their
   * target: what was laid out somewhere else goes on from where it is drawn.
   */
  readonly shift: (by: Partial<Record<K, number>>) => void;
  /** Where each value is now. */
  readonly now: () => Readonly<Record<K, number>>;
  readonly stop: () => void;
}

export function sprung<K extends string>(
  initial: Readonly<Record<K, number>>,
  spring: SpringName,
  write: (values: Readonly<Record<K, number>>) => void,
  /** Told each time every value has arrived. */
  rested: () => void = () => {},
): Sprung<K> {
  const keys: Array<K> = [];
  const channels = new Map<K, Channel>();
  for (const key in initial) {
    keys.push(key);
    channels.set(key, { state: { x: initial[key], v: 0 }, to: initial[key], spring, wait: 0 });
  }
  const values: Record<K, number> = { ...initial };
  let stop: (() => void) | null = null;

  const draw = () => {
    for (const [key, channel] of channels) values[key] = channel.state.x;
    write(values);
  };

  const step = (dt: number): boolean => {
    let moving = false;
    for (const channel of channels.values()) {
      if (!Number.isFinite(dt)) {
        channel.state = { x: channel.to, v: 0 };
        channel.wait = 0;
        continue;
      }
      const seconds = Math.max(0, dt - channel.wait);
      channel.wait = Math.max(0, channel.wait - dt);
      if (channel.wait > 0) {
        moving = true;
        continue;
      }
      const { frequency, damping } = springs[channel.spring];
      const next = springStep(channel.state, channel.to, frequency, damping, seconds);
      const arrived =
        Math.abs(next.x - channel.to) < REST.distance && Math.abs(next.v) < REST.speed;
      channel.state = arrived ? { x: channel.to, v: 0 } : next;
      if (!arrived) moving = true;
    }
    draw();
    if (!moving) {
      stop = null;
      rested();
    }
    return moving;
  };

  const start = () => {
    if (stop !== null) return;
    if (reducedMotion()) {
      step(Number.POSITIVE_INFINITY);
      return;
    }
    stop = drive(step);
  };

  return {
    to: (targets, travel = {}) => {
      for (const key of keys) {
        const to = targets[key];
        const channel = channels.get(key);
        if (to === undefined || channel === undefined) continue;
        channel.to = to;
        channel.wait = (travel.delay ?? 0) / 1000;
        if (travel.spring !== undefined) channel.spring = travel.spring;
      }
      start();
    },
    jump: (at) => {
      for (const key of keys) {
        const x = at[key];
        const channel = channels.get(key);
        if (x === undefined || channel === undefined) continue;
        channel.state = { x, v: 0 };
        channel.to = x;
        channel.wait = 0;
      }
      draw();
    },
    shift: (by) => {
      for (const key of keys) {
        const delta = by[key];
        const channel = channels.get(key);
        if (delta === undefined || channel === undefined) continue;
        channel.state = { x: channel.state.x + delta, v: channel.state.v };
      }
      draw();
    },
    now: () => {
      for (const [key, channel] of channels) values[key] = channel.state.x;
      return values;
    },
    stop: () => {
      stop?.();
      stop = null;
    },
  };
}
