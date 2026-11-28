// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a bot's pointer moves over a page, the same on the web, in the desktop
// tab's page and on Android (docs/design/design-language.md#motion). Pure
// functions on plain numbers, each a worklet, so Reanimated runs them on the
// UI thread and every drawing runs the same code.
//
// The method follows cursor-motion by xnmeet (https://github.com/xnmeet/cursor-motion,
// MIT), itself a port of open-codex-computer-use by iFurySt
// (https://github.com/iFurySt/open-codex-computer-use, MIT): a handful of cubic
// paths scored on how they turn and how well they carry on the pointer's
// heading, progress on a spring, and a soft filter on the drawn tip. The
// families, the weights and the springs here are J3 Bots' own; none of those
// projects' tables are used.
import { pointer, springStep } from "@j3-bots/design-tokens";
import type { PageSize, Point } from "./browser.ts";

/** A cubic Bézier path: from `x0, y0`, through its two controls, to `x1, y1`. */
export interface PointerPath {
  readonly x0: number;
  readonly y0: number;
  readonly c1x: number;
  readonly c1y: number;
  readonly c2x: number;
  readonly c2y: number;
  readonly x1: number;
  readonly y1: number;
}

/** Where a path may go, in page px. */
export interface PointerBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How far inside the page's edges a path stays, in px. */
const BOUNDS_INSET = 8;

/** A path stays inside the page, this far from its edges. */
export const pointerBounds = (page: PageSize): PointerBounds => {
  "worklet";
  return {
    left: BOUNDS_INSET,
    top: BOUNDS_INSET,
    right: Math.max(BOUNDS_INSET, page.width - BOUNDS_INSET),
    bottom: Math.max(BOUNDS_INSET, page.height - BOUNDS_INSET),
  };
};

/**
 * A family of paths: which side it bows to (0 the side the heading already
 * turns), how far as a share of the move, how early its bow peaks (over 0.5
 * early, under late), and what choosing it costs before anything is measured.
 */
interface Family {
  readonly side: -1 | 0 | 1;
  readonly bow: number;
  readonly early: number;
  readonly cost: number;
}

/** Direct; lead and settle, each way; sweep, each way. */
const FAMILIES: ReadonlyArray<Family> = [
  { side: 0, bow: 0.05, early: 0.5, cost: 0 },
  { side: -1, bow: 0.14, early: 0.72, cost: 4 },
  { side: 1, bow: 0.14, early: 0.72, cost: 4 },
  { side: -1, bow: 0.14, early: 0.3, cost: 6 },
  { side: 1, bow: 0.14, early: 0.3, cost: 6 },
  { side: -1, bow: 0.27, early: 0.5, cost: 12 },
  { side: 1, bow: 0.27, early: 0.5, cost: 12 },
];

/** What each measure of a path costs. */
const WEIGHTS = {
  excess: 120,
  energy: 55,
  sharpest: 45,
  turning: 8,
  leave: 38,
  outside: 60,
} as const;

/** How far along the move its controls reach, leaving and arriving. */
const REACH = { leave: 0.32, arrive: 0.26 } as const;
/** How many points a path is measured at. */
const SAMPLES = 24;
/** A move this long or longer bows the most, in px. */
const LONG_MOVE = 700;
/** How much the heading shapes a move: all of it while moving, less from rest. */
const CARRY = { moving: 1, resting: 0.35 } as const;
/** A move this short is no move, in px: it arrives at once. */
const NO_MOVE = 0.5;

const clamp = (value: number, low: number, high: number): number => {
  "worklet";
  return Math.min(high, Math.max(low, value));
};

const smoothstep = (k: number): number => {
  "worklet";
  const t = clamp(k, 0, 1);
  return t * t * (3 - 2 * t);
};

/** The angle from `a` to `b`, between -π and π. */
const turnBetween = (ax: number, ay: number, bx: number, by: number): number => {
  "worklet";
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
};

/** Where `path` is at `t`, 0 at its start to 1 at its end. */
export const pathAt = (path: PointerPath, t: number): Point => {
  "worklet";
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * path.x0 + b * path.c1x + c * path.c2x + d * path.x1,
    y: a * path.y0 + b * path.c1y + c * path.c2y + d * path.y1,
  };
};

/** The direction `path` heads in at `t`, of length 1; `fallback` where it has none. */
const tangentAt = (path: PointerPath, t: number, fallback: Point): Point => {
  "worklet";
  const u = 1 - t;
  const x =
    3 * u * u * (path.c1x - path.x0) +
    6 * u * t * (path.c2x - path.c1x) +
    3 * t * t * (path.x1 - path.c2x);
  const y =
    3 * u * u * (path.c1y - path.y0) +
    6 * u * t * (path.c2y - path.c1y) +
    3 * t * t * (path.y1 - path.c2y);
  const length = Math.hypot(x, y);
  return length < 1e-9 ? fallback : { x: x / length, y: y / length };
};

/** One family's path from `from` to `to`, leaving along `heading` as much as `carry` says. */
const familyPath = (
  from: Point,
  to: Point,
  family: Family,
  heading: Point,
  carry: number,
  naturalSide: number,
): PointerPath => {
  "worklet";
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const dirX = dx / distance;
  const dirY = dy / distance;
  // Turning back on itself, it leaves along the line: a hook back reads as a mistake.
  const along = clamp((heading.x * dirX + heading.y * dirY + 0.5) / 1.5, 0, 1);
  const k = 0.55 * carry * along;
  const leaveX = dirX * (1 - k) + heading.x * k;
  const leaveY = dirY * (1 - k) + heading.y * k;
  const leaveLength = Math.hypot(leaveX, leaveY);
  const lx = leaveLength < 1e-9 ? dirX : leaveX / leaveLength;
  const ly = leaveLength < 1e-9 ? dirY : leaveY / leaveLength;
  const side = family.side === 0 ? naturalSide : family.side;
  const bow = family.bow * distance * (0.8 + 0.4 * Math.min(distance / LONG_MOVE, 1)) * side;
  // A cubic's middle sits at 3/8 of its controls' offsets: 2.6 of them puts it near `bow`.
  const early = bow * family.early * 2.6;
  const late = bow * (1 - family.early) * 2.6;
  return {
    x0: from.x,
    y0: from.y,
    c1x: from.x + lx * distance * REACH.leave - dirY * early,
    c1y: from.y + ly * distance * REACH.leave + dirX * early,
    c2x: to.x - dirX * distance * REACH.arrive - dirY * late,
    c2y: to.y - dirY * distance * REACH.arrive + dirX * late,
    x1: to.x,
    y1: to.y,
  };
};

/** What a path costs, from its shape; `inside` whether it keeps within `bounds`. */
const costOf = (
  path: PointerPath,
  bounds: PointerBounds,
  distance: number,
  heading: Point,
  carry: number,
): { readonly cost: number; readonly inside: boolean } => {
  "worklet";
  let length = 0;
  let energy = 0;
  let sharpest = 0;
  let turning = 0;
  let inside = true;
  let px = path.x0;
  let py = path.y0;
  let angle: number | null = null;
  for (let i = 1; i <= SAMPLES; i++) {
    const q = pathAt(path, i / SAMPLES);
    if (q.x < bounds.left || q.x > bounds.right || q.y < bounds.top || q.y > bounds.bottom) {
      inside = false;
    }
    const dx = q.x - px;
    const dy = q.y - py;
    const step = Math.hypot(dx, dy);
    if (step > 0.01) {
      const a = Math.atan2(dy, dx);
      length += step;
      if (angle !== null) {
        let turn = a - angle;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        energy += turn * turn;
        sharpest = Math.max(sharpest, Math.abs(turn));
        turning += Math.abs(turn);
      }
      angle = a;
      px = q.x;
      py = q.y;
    }
  }
  const leaving = tangentAt(path, 0, heading);
  const leaveTurn = Math.abs(turnBetween(heading.x, heading.y, leaving.x, leaving.y)) / Math.PI;
  return {
    cost:
      WEIGHTS.excess * Math.max(length / distance - 1, 0) +
      WEIGHTS.energy * energy +
      WEIGHTS.sharpest * sharpest +
      WEIGHTS.turning * turning +
      WEIGHTS.leave * carry * leaveTurn +
      (inside ? 0 : WEIGHTS.outside),
    inside,
  };
};

/**
 * The path a pointer at `from` takes to `to`, heading along `heading` (of
 * any length; none at all reads as heading straight there), `moving` when
 * it is mid-move. Each family's path is measured and costed; the cheapest
 * that stays inside `bounds` wins, or the cheapest of all if none does.
 */
export const pointerPath = (
  from: Point,
  to: Point,
  heading: Point,
  moving: boolean,
  bounds: PointerBounds,
): PointerPath => {
  "worklet";
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const dirX = dx / distance;
  const dirY = dy / distance;
  const headingLength = Math.hypot(heading.x, heading.y);
  const h =
    headingLength < 1e-9
      ? { x: dirX, y: dirY }
      : { x: heading.x / headingLength, y: heading.y / headingLength };
  const carry = moving ? CARRY.moving : CARRY.resting;
  // With nothing else to go by, a hand bows its moves a little, to the side it already turns.
  const naturalSide = h.x * dirY - h.y * dirX >= 0 ? 1 : -1;
  // Any family beats the straight line, which costs too much to be chosen.
  let best: PointerPath = {
    x0: from.x,
    y0: from.y,
    c1x: from.x,
    c1y: from.y,
    c2x: to.x,
    c2y: to.y,
    x1: to.x,
    y1: to.y,
  };
  let bestCost = Number.POSITIVE_INFINITY;
  let bestInside = false;
  for (const family of FAMILIES) {
    const path = familyPath(from, to, family, h, carry, naturalSide);
    const measured = costOf(path, bounds, distance, h, carry);
    const cost = family.cost + measured.cost;
    // One inside the bounds beats any outside them.
    const better =
      (measured.inside && !bestInside) || (measured.inside === bestInside && cost < bestCost);
    if (better) {
      best = path;
      bestCost = cost;
      bestInside = measured.inside;
    }
  }
  return best;
};

/**
 * How long a move answers in, in seconds: `share` is its length as a share
 * of the page's diagonal. Short moves answer sooner, so the pointer keeps up
 * with a bot working in one place; half the diagonal and more take the longest.
 */
export const moveResponse = (share: number): number => {
  "worklet";
  const { shortest, longest } = pointer.response;
  return shortest + (longest - shortest) * Math.sqrt(Math.min(1, Math.max(0, share) / 0.5));
};

/**
 * How far a move is `seconds` after it set off from rest on a progress spring
 * answering in `response` seconds, from 0 to exactly 1 once it first reaches
 * the end. What follows a pointer and travels in a straight line, as the view
 * that follows a bot, arrives with it.
 */
export const progressAt = (seconds: number, response: number): number => {
  "worklet";
  if (response <= 0 || !(seconds > 0)) return response <= 0 ? 1 : 0;
  const damping = pointer.progressDamping;
  const turn = ((2 * Math.PI) / response) * Math.sqrt(1 - damping * damping);
  // The spring from rest first reaches 1 when its swing has turned this far.
  const reaches = (Math.PI - Math.atan(Math.sqrt(1 - damping * damping) / damping)) / turn;
  if (seconds >= reaches) return 1;
  return springStep({ x: 0, v: 0 }, 1, 1 / response, damping, seconds).x;
};

/**
 * A pointer's motion, a record of numbers that `stepPointer` moves on: its
 * path and its progress along it, where that puts it (`x`, `y`, and the way
 * it heads there), the tip as drawn and how fast it goes, the arrow's lean in
 * degrees, and the thinking drift. All lengths in page px, times in seconds.
 */
export interface PointerMotion {
  readonly path: PointerPath;
  /** Whether a move is under way. */
  readonly moving: boolean;
  readonly progress: number;
  readonly progressSpeed: number;
  /** The move's spring answers in this many seconds. */
  readonly response: number;
  /** Where it is on its path, which the tip follows. */
  readonly x: number;
  readonly y: number;
  /** The way it heads, of length 1. */
  readonly headingX: number;
  readonly headingY: number;
  /** The tip as it is drawn, and its speed per axis, px a second. */
  readonly tipX: number;
  readonly tipY: number;
  readonly tipSpeedX: number;
  readonly tipSpeedY: number;
  /** The arrow's lean, in degrees, and how fast it changes. */
  readonly lean: number;
  readonly leanSpeed: number;
  /** How long the drift has run since the last point, and how far it is eased in, 0 to 1. */
  readonly driftTime: number;
  readonly driftEnvelope: number;
}

/** A pointer at rest at `at`, upright, heading the way the arrow points. */
export const restingAt = (at: Point): PointerMotion => {
  "worklet";
  const axis = (pointer.axis * Math.PI) / 180;
  return {
    path: { x0: at.x, y0: at.y, c1x: at.x, c1y: at.y, c2x: at.x, c2y: at.y, x1: at.x, y1: at.y },
    moving: false,
    progress: 1,
    progressSpeed: 0,
    response: pointer.response.shortest,
    x: at.x,
    y: at.y,
    headingX: Math.cos(axis),
    headingY: Math.sin(axis),
    tipX: at.x,
    tipY: at.y,
    tipSpeedX: 0,
    tipSpeedY: 0,
    lean: 0,
    leanSpeed: 0,
    driftTime: 0,
    driftEnvelope: 0,
  };
};

/**
 * `motion` setting off for `to` on a spring answering in `response` seconds,
 * on a new path from where it is on its path and the way it heads, mid-move
 * too: the tip keeps its speed, so the move bends instead of starting again.
 * A point it is already on arrives on the next step. The drift starts again.
 */
export const startMove = (
  motion: PointerMotion,
  to: Point,
  response: number,
  bounds: PointerBounds,
): PointerMotion => {
  "worklet";
  const from = { x: motion.x, y: motion.y };
  const none = Math.hypot(to.x - from.x, to.y - from.y) < NO_MOVE;
  const path = none
    ? { x0: to.x, y0: to.y, c1x: to.x, c1y: to.y, c2x: to.x, c2y: to.y, x1: to.x, y1: to.y }
    : pointerPath(from, to, { x: motion.headingX, y: motion.headingY }, motion.moving, bounds);
  return {
    ...motion,
    path,
    moving: true,
    progress: none ? 1 : 0,
    progressSpeed: 0,
    response,
    driftTime: 0,
  };
};

/**
 * A pointer new to the page, or shown again: it comes in to `at` from behind
 * its arrow (`pointer.arriveFrom` below and to the right), along the arrow's
 * own axis, so it arrives upright.
 */
export const arrivingAt = (at: Point, bounds: PointerBounds): PointerMotion => {
  "worklet";
  const { x, y } = pointer.arriveFrom;
  const length = Math.hypot(x, y);
  const behind = restingAt({ x: at.x + x, y: at.y + y });
  return startMove(
    { ...behind, headingX: -x / length, headingY: -y / length },
    at,
    pointer.arriveResponse,
    bounds,
  );
};

/** What `stepPointer` takes besides the time. */
export interface PointerStepOptions {
  /** The bot thinks before it acts: the tip drifts, while it does not move. */
  readonly thinking: boolean;
  /** How long the drift may run since the last point, in seconds: one period in a page, unbounded over a picture. */
  readonly driftBudget: number;
  /** Whether the arrow leans: false holds it upright. */
  readonly lean: boolean;
  /** Reduced motion: it is where it goes at once, upright, and does not drift. */
  readonly reduced: boolean;
}

/** One step of a pointer's motion. */
export interface PointerStep {
  readonly motion: PointerMotion;
  /** The move reached its point on this step, and on no other. */
  readonly arrived: boolean;
  /** Nothing changes from here without a new point or a think: the drawing can stop. */
  readonly resting: boolean;
}

/** A step longer than this, in seconds, collapses: everything lands where it was going. */
const LONGEST_STEP = 1;
/** Close enough to the end of a move, as a share of it, having reached it. */
const CLOSE_ENOUGH = 0.01;
/** The tip is where it goes when this close, in px, and this slow, in px a second. */
const TIP_REST = { distance: 0.02, speed: 0.5 } as const;
/** The lean is where it goes when this close, in degrees, and this slow, in degrees a second. */
const LEAN_REST = { distance: 0.03, speed: 0.3 } as const;

/**
 * Where the arrow leans for a tip going at `vx, vy` px a second, in degrees:
 * across its own axis the most, along it or straight back none, so it never
 * flips sides; upright under `pointer.lean.from`, fully leant from `full`.
 */
export const leanFor = (vx: number, vy: number): number => {
  "worklet";
  const { most, from, full } = pointer.lean;
  const speed = Math.hypot(vx, vy);
  if (speed <= from) return 0;
  const axis = (pointer.axis * Math.PI) / 180;
  return most * Math.sin(Math.atan2(vy, vx) - axis) * smoothstep((speed - from) / (full - from));
};

/** One piece of `stepPointer`, `dt` seconds long. */
const advance = (motion: PointerMotion, dt: number, options: PointerStepOptions): PointerStep => {
  "worklet";
  // Progress on its spring, along the path.
  let { moving, progress, progressSpeed, x, y, headingX, headingY } = motion;
  let arrived = false;
  if (moving) {
    const next = springStep(
      { x: progress, v: progressSpeed },
      1,
      1 / motion.response,
      pointer.progressDamping,
      dt,
    );
    progress = next.x;
    progressSpeed = next.v;
    const ran = motion.progress >= 1 || progress >= 1;
    const along = clamp(progress, 0, 1);
    const at = pathAt(motion.path, along);
    const heading = tangentAt(motion.path, Math.min(along, 0.999), { x: headingX, y: headingY });
    x = at.x;
    y = at.y;
    headingX = heading.x;
    headingY = heading.y;
    if (ran && Math.abs(1 - progress) <= CLOSE_ENOUGH) {
      moving = false;
      progress = 1;
      progressSpeed = 0;
      x = motion.path.x1;
      y = motion.path.y1;
      arrived = true;
    }
  }

  // Thinking: a figure eight, eased in and out, within its budget.
  const drifts = options.thinking && !moving && motion.driftTime < options.driftBudget;
  const ease = pointer.drift.ease / 1000;
  const driftEnvelope = clamp(motion.driftEnvelope + (drifts ? dt : -dt) / ease, 0, 1);
  const driftTime =
    motion.driftEnvelope > 0 || driftEnvelope > 0 ? motion.driftTime + dt : motion.driftTime;
  const wave = (2 * Math.PI * driftTime) / (pointer.drift.period / 1000);
  const eased = smoothstep(driftEnvelope);
  const targetX = x + pointer.drift.size * Math.sin(wave) * eased;
  const targetY = y + pointer.drift.size * 0.55 * Math.sin(2 * wave) * eased;

  // The tip follows through its filter, and snaps once close enough.
  const follow = 1 / pointer.follow.response;
  const tx = springStep(
    { x: motion.tipX, v: motion.tipSpeedX },
    targetX,
    follow,
    pointer.follow.damping,
    dt,
  );
  const ty = springStep(
    { x: motion.tipY, v: motion.tipSpeedY },
    targetY,
    follow,
    pointer.follow.damping,
    dt,
  );
  const tipRests =
    Math.abs(tx.x - targetX) < TIP_REST.distance &&
    Math.abs(ty.x - targetY) < TIP_REST.distance &&
    Math.abs(tx.v) + Math.abs(ty.v) < TIP_REST.speed;
  const tipX = tipRests ? targetX : tx.x;
  const tipY = tipRests ? targetY : ty.x;
  const tipSpeedX = tipRests ? 0 : tx.v;
  const tipSpeedY = tipRests ? 0 : ty.v;

  // The lean, from the tip's own speed, so it follows what is drawn and settles as it does.
  let lean = 0;
  let leanSpeed = 0;
  if (options.lean) {
    const to = leanFor(tipSpeedX, tipSpeedY);
    const next = springStep(
      { x: motion.lean, v: motion.leanSpeed },
      to,
      1 / pointer.lean.response,
      pointer.lean.damping,
      dt,
    );
    const rests = Math.abs(next.x - to) < LEAN_REST.distance && Math.abs(next.v) < LEAN_REST.speed;
    lean = rests ? to : clamp(next.x, -pointer.lean.most, pointer.lean.most);
    leanSpeed = rests || Math.abs(next.x) > pointer.lean.most ? 0 : next.v;
  }

  return {
    motion: {
      path: motion.path,
      moving,
      progress,
      progressSpeed,
      response: motion.response,
      x,
      y,
      headingX,
      headingY,
      tipX,
      tipY,
      tipSpeedX,
      tipSpeedY,
      lean,
      leanSpeed,
      driftTime,
      driftEnvelope,
    },
    arrived,
    resting: !moving && !drifts && driftEnvelope === 0 && tipRests && lean === 0 && leanSpeed === 0,
  };
};

/** Each step is taken in pieces this short, in seconds, so every frame rate draws the same motion. */
const PIECE = 1 / 240;

/**
 * `motion` after `seconds`: progress along its path on its spring, the tip
 * following through the filter, the drift while it thinks and stays, and the
 * arrow's lean from the tip's own speed. Each spring snaps to its target once
 * close enough, so a pointer that has arrived comes to rest exactly. A step
 * is taken in pieces of `PIECE`, since the tip follows a point that moves
 * through the step; one longer than `LONGEST_STEP`, as after a tab slept,
 * lands where it was going.
 */
export const stepPointer = (
  motion: PointerMotion,
  seconds: number,
  options: PointerStepOptions,
): PointerStep => {
  "worklet";
  const dt = Math.max(0, seconds);
  if (options.reduced || !(dt <= LONGEST_STEP)) {
    const settled: PointerMotion = {
      ...motion,
      moving: false,
      progress: 1,
      progressSpeed: 0,
      x: motion.moving ? motion.path.x1 : motion.x,
      y: motion.moving ? motion.path.y1 : motion.y,
      tipX: motion.moving ? motion.path.x1 : motion.x,
      tipY: motion.moving ? motion.path.y1 : motion.y,
      tipSpeedX: 0,
      tipSpeedY: 0,
      lean: 0,
      leanSpeed: 0,
      driftEnvelope: 0,
    };
    const drifts = !options.reduced && options.thinking && settled.driftTime < options.driftBudget;
    return { motion: settled, arrived: motion.moving, resting: !drifts };
  }
  const pieces = Math.max(1, Math.ceil(dt / PIECE - 1e-6));
  let step: PointerStep = { motion, arrived: false, resting: false };
  let arrived = false;
  for (let piece = 0; piece < pieces; piece += 1) {
    step = advance(step.motion, dt / pieces, options);
    arrived ||= step.arrived;
  }
  return { motion: step.motion, arrived, resting: step.resting };
};

/** Which side of its point a tag sits on: right (1) or left (-1), below (1) or above (-1). */
export interface TagSide {
  readonly x: 1 | -1;
  readonly y: 1 | -1;
}

/** Another bot's tag, as `tagSide` keeps clear of it. */
export interface OtherTag {
  readonly at: Point;
  readonly width: number;
  readonly side: TagSide;
}

/** The box a tag of `width` takes beside `at`, on `side`. */
const tagBox = (at: Point, width: number, side: TagSide) => {
  "worklet";
  return {
    left: side.x > 0 ? at.x + pointer.tagAt.x : at.x - pointer.tagGap - width,
    top: side.y > 0 ? at.y + pointer.tagAt.y : at.y - pointer.tagGap - pointer.tagHeight,
    width,
    height: pointer.tagHeight,
  };
};

/** How far apart two tags stay, in px. */
const TAG_CLEARANCE = 4;

const tagsMeet = (a: ReturnType<typeof tagBox>, b: ReturnType<typeof tagBox>): boolean => {
  "worklet";
  return (
    a.left < b.left + b.width + TAG_CLEARANCE &&
    b.left < a.left + a.width + TAG_CLEARANCE &&
    a.top < b.top + b.height + TAG_CLEARANCE &&
    b.top < a.top + a.height + TAG_CLEARANCE
  );
};

/**
 * Where the tag of a pointer at `at` sits, `width` px wide, in a page of
 * `page`'s size: to the right of the arrow and below it, on the left where
 * it would pass the page's right edge, above where it would pass the bottom.
 * Where that meets another bot's tag, it flips away: up or down first, then
 * across, then both, to the first side that meets none and stays in the
 * page; with none such, it keeps to the page. All in the px the tags are
 * drawn in.
 */
export const tagSide = (
  at: Point,
  width: number,
  page: PageSize,
  others: ReadonlyArray<OtherTag>,
): TagSide => {
  "worklet";
  const x: 1 | -1 = at.x + pointer.tagAt.x + width > page.width - pointer.tagMargin ? -1 : 1;
  const y: 1 | -1 =
    at.y + pointer.tagAt.y + pointer.tagHeight > page.height - pointer.tagMargin ? -1 : 1;
  const flippedX: 1 | -1 = x > 0 ? -1 : 1;
  const flippedY: 1 | -1 = y > 0 ? -1 : 1;
  const sides: ReadonlyArray<TagSide> = [
    { x, y },
    { x, y: flippedY },
    { x: flippedX, y },
    { x: flippedX, y: flippedY },
  ];
  for (const side of sides) {
    const box = tagBox(at, width, side);
    const inPage =
      box.left >= pointer.tagMargin &&
      box.top >= pointer.tagMargin &&
      box.left + box.width <= page.width - pointer.tagMargin &&
      box.top + box.height <= page.height - pointer.tagMargin;
    if (
      inPage &&
      others.every((other) => !tagsMeet(box, tagBox(other.at, other.width, other.side)))
    ) {
      return side;
    }
  }
  return { x, y };
};

/** Where a tag on `side` has its corner, from the point, in px. */
export const tagOffset = (side: TagSide, width: number): Point => {
  "worklet";
  return {
    x: side.x > 0 ? pointer.tagAt.x : -pointer.tagGap - width,
    y: side.y > 0 ? pointer.tagAt.y : -pointer.tagGap - pointer.tagHeight,
  };
};
