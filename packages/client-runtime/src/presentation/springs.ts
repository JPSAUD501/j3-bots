// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The design language's springs, until the design tokens carry them under the same names:
 * then this module goes, and its importers read `springs` and `eases` from
 * `@j3-bots/design-tokens`.
 *
 * Each spring is a real damped spring, given as a frequency (Hz) and a
 * damping ratio. Web draws it as a CSS `linear()` easing over the time it
 * takes to settle; mobile hands the same physics to Reanimated.
 */

export interface Spring {
  readonly frequency: number;
  readonly damping: number;
  /** The spring's path from 0 to 1, as a CSS easing. */
  readonly easing: string;
  /** How long it takes to settle, in ms. */
  readonly duration: number;
}

/** Steps a spring of `frequency` and `damping` from `x` toward 1 for `dt` seconds. */
function step(
  state: { x: number; v: number },
  frequency: number,
  damping: number,
  dt: number,
): void {
  const w = 2 * Math.PI * frequency;
  let n = Math.max(1, Math.ceil(dt / 0.006));
  const h = dt / n;
  while (n-- > 0) {
    state.v += (-w * w * (state.x - 1) - 2 * damping * w * state.v) * h;
    state.x += state.v * h;
  }
}

function spring(frequency: number, damping: number): Spring {
  const probe = { x: 0, v: 0 };
  let settle = 0;
  for (; settle < 3; settle += 1 / 240) {
    step(probe, frequency, damping, 1 / 240);
    if (settle > 0.1 && Math.abs(probe.x - 1) < 0.003 && Math.abs(probe.v) < 0.03) break;
  }
  const points = Math.min(90, Math.max(14, Math.round(settle * 60)));
  const path = { x: 0, v: 0 };
  const stops: Array<number> = [];
  for (let i = 0; i < points; i++) {
    stops.push(Number(path.x.toFixed(3)));
    step(path, frequency, damping, settle / points);
  }
  stops.push(1);
  return {
    frequency,
    damping,
    easing: `linear(${stops.join(",")})`,
    duration: Math.round(settle * 1000),
  };
}

export const springs = {
  /** Things that arrive: a bot, a badge. Overshoots and settles fast. */
  pop: spring(3.6, 0.5),
  /** Things that change in place: a look, a size. */
  soft: spring(2.3, 0.72),
  /** Things that move across: a screen, a sheet. */
  slide: spring(2.5, 0.86),
} as const;

export const eases = {
  out: "cubic-bezier(.2,.8,.2,1)",
} as const;
