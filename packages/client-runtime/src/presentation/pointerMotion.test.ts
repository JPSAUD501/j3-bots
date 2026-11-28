// SPDX-License-Identifier: AGPL-3.0-or-later
import { pointer } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";
import type { Point } from "./browser.ts";
import {
  arrivingAt,
  leanFor,
  moveResponse,
  pathAt,
  pointerBounds,
  type PointerMotion,
  type PointerStep,
  type PointerStepOptions,
  restingAt,
  startMove,
  stepPointer,
  tagSide,
} from "./pointerMotion.ts";

const page = { width: 1280, height: 800 };
const bounds = pointerBounds(page);
const moving: PointerStepOptions = { thinking: false, driftBudget: 0, lean: true, reduced: false };
const period = pointer.drift.period / 1000;

/** Steps `motion` at `hz` for `seconds`, telling `each` of every step. */
const run = (
  motion: PointerMotion,
  seconds: number,
  hz: number,
  options: PointerStepOptions = moving,
  each: (step: PointerStep, time: number) => void = () => {},
): PointerMotion => {
  let now = motion;
  const frames = Math.round(seconds * hz);
  for (let frame = 1; frame <= frames; frame += 1) {
    const step = stepPointer(now, 1 / hz, options);
    each(step, frame / hz);
    now = step.motion;
  }
  return now;
};

const far = (from: Point, to: Point, response = moveResponse(0.6)) =>
  startMove(restingAt(from), to, response, bounds);

describe("a bot pointer's move", () => {
  it("lands exactly on its point and says it arrived once", () => {
    let arrivals = 0;
    const end = run(far({ x: 100, y: 100 }, { x: 900, y: 600 }), 3, 60, moving, (step) => {
      if (step.arrived) arrivals += 1;
    });
    expect(arrivals).toBe(1);
    expect({ x: end.tipX, y: end.tipY }).toEqual({ x: 900, y: 600 });
  });

  it("stays inside the page between points near each edge and corner", () => {
    const near = [
      { x: 10, y: 10 },
      { x: 640, y: 10 },
      { x: 1270, y: 10 },
      { x: 1270, y: 400 },
      { x: 1270, y: 790 },
      { x: 640, y: 790 },
      { x: 10, y: 790 },
      { x: 10, y: 400 },
    ].map((point) => ({
      x: Math.min(Math.max(point.x, bounds.left), bounds.right),
      y: Math.min(Math.max(point.y, bounds.top), bounds.bottom),
    }));
    for (const from of near) {
      for (const to of near) {
        if (from === to) continue;
        // Heading every way, as the move before may have left it.
        for (const heading of [
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: -1, y: -1 },
        ]) {
          const motion = { ...restingAt(from), headingX: heading.x, headingY: heading.y };
          const { path } = startMove(motion, to, moveResponse(0.5), bounds);
          for (let i = 0; i <= 48; i += 1) {
            const point = pathAt(path, i / 48);
            expect(point.x).toBeGreaterThanOrEqual(bounds.left);
            expect(point.x).toBeLessThanOrEqual(bounds.right);
            expect(point.y).toBeGreaterThanOrEqual(bounds.top);
            expect(point.y).toBeLessThanOrEqual(bounds.bottom);
          }
        }
      }
    }
  });

  it("bends into a new point mid-move, without a jump or a stop", () => {
    const hz = 60;
    const steps: Array<number> = [];
    let motion = run(far({ x: 100, y: 400 }, { x: 1100, y: 400 }), 0.25, hz);
    let last = { x: motion.tipX, y: motion.tipY };
    motion = run(motion, 3 / hz, hz, moving, (step) => {
      steps.push(Math.hypot(step.motion.tipX - last.x, step.motion.tipY - last.y));
      last = { x: step.motion.tipX, y: step.motion.tipY };
    });
    const before = steps.at(-1) ?? 0;
    motion = startMove(motion, { x: 600, y: 100 }, moveResponse(0.3), bounds);
    const next = stepPointer(motion, 1 / hz, moving).motion;
    const after = Math.hypot(next.tipX - last.x, next.tipY - last.y);
    expect(before).toBeGreaterThan(5);
    expect(after).toBeLessThanOrEqual(Math.max(...steps) * 1.05);
    expect(after).toBeGreaterThan(before * 0.5);
  });

  it("is in the same place at the same time at 30, 60 and 120 Hz", () => {
    const start = far({ x: 200, y: 600 }, { x: 1000, y: 150 });
    for (const time of [0.2, 0.4, 0.7]) {
      const [a, b, c] = [30, 60, 120].map((hz) => run(start, time, hz));
      if (a === undefined || b === undefined || c === undefined) throw new Error("no step");
      expect(Math.hypot(a.tipX - c.tipX, a.tipY - c.tipY)).toBeLessThan(0.5);
      expect(Math.hypot(b.tipX - c.tipX, b.tipY - c.tipY)).toBeLessThan(0.5);
    }
  });

  it("rests within a second of arriving, and its tip changes no more", () => {
    let arrivedAt: number | null = null;
    let restedAt: number | null = null;
    const end = run(far({ x: 100, y: 100 }, { x: 1100, y: 700 }), 4, 60, moving, (step, time) => {
      if (step.arrived) arrivedAt = time;
      if (step.resting && restedAt === null) restedAt = time;
    });
    if (arrivedAt === null || restedAt === null) throw new Error("it never arrived or rested");
    expect(restedAt - arrivedAt).toBeLessThan(1);
    const later = run(end, 1, 60);
    expect(later).toEqual(end);
  });

  it("answers longer the longer the move, between the shortest and the longest", () => {
    const shares = [0, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5];
    const responses = shares.map(moveResponse);
    expect(responses).toEqual([...responses].sort((a, b) => a - b));
    expect(new Set(responses).size).toBe(responses.length);
    expect(responses[0]).toBe(pointer.response.shortest);
    expect(moveResponse(0.5)).toBe(pointer.response.longest);
    expect(moveResponse(1)).toBe(pointer.response.longest);
  });

  it("comes in to a new page from behind its arrow, and arrives upright", () => {
    const at = { x: 400, y: 300 };
    const arriving = arrivingAt(at, bounds);
    expect({ x: arriving.x, y: arriving.y }).toEqual({
      x: at.x + pointer.arriveFrom.x,
      y: at.y + pointer.arriveFrom.y,
    });
    let most = 0;
    const end = run(arriving, 2, 60, moving, (step) => {
      most = Math.max(most, Math.abs(step.motion.lean));
    });
    expect({ x: end.tipX, y: end.tipY }).toEqual(at);
    expect(most).toBeLessThan(3);
  });
});

describe("a bot pointer's lean", () => {
  it("never passes its limit, and ends exactly upright so the pointer rests", () => {
    let most = 0;
    let rested = false;
    // Across the arrow's axis, the way that leans it most, and back.
    let motion = run(
      far({ x: 100, y: 100 }, { x: 1150, y: 700 }, 0.45),
      0.5,
      120,
      moving,
      (step) => {
        most = Math.max(most, Math.abs(step.motion.lean));
      },
    );
    motion = startMove(motion, { x: 100, y: 700 }, 0.45, bounds);
    const end = run(motion, 3, 120, moving, (step) => {
      most = Math.max(most, Math.abs(step.motion.lean));
      rested ||= step.resting;
    });
    expect(most).toBeGreaterThan(pointer.lean.most / 2);
    expect(most).toBeLessThanOrEqual(pointer.lean.most);
    expect(end.lean).toBe(0);
    expect(end.leanSpeed).toBe(0);
    expect(rested).toBe(true);
  });

  it("is upright under its speed and along the arrow's own axis", () => {
    expect(leanFor(30, 0)).toBe(0);
    expect(leanFor(0, -pointer.lean.from)).toBe(0);
    const axis = (pointer.axis * Math.PI) / 180;
    expect(leanFor(Math.cos(axis) * 900, Math.sin(axis) * 900)).toBeCloseTo(0, 9);
    expect(leanFor(-Math.cos(axis) * 900, -Math.sin(axis) * 900)).toBeCloseTo(0, 9);
    expect(Math.abs(leanFor(900, -900))).toBeCloseTo(pointer.lean.most, 9);
  });

  it("stays upright throughout when it may not lean", () => {
    run(far({ x: 100, y: 100 }, { x: 1150, y: 700 }), 2, 60, { ...moving, lean: false }, (step) =>
      expect(step.motion.lean).toBe(0),
    );
  });
});

describe("a bot pointer that thinks", () => {
  const thinking = { ...moving, thinking: true };

  it("drifts upright, and in a page rests within a period while it still thinks", () => {
    const at = { x: 400, y: 300 };
    let moved = 0;
    let restedAt: number | null = null;
    run(
      startMove(restingAt(at), at, 0.45, bounds),
      6,
      60,
      { ...thinking, driftBudget: period },
      (step, time) => {
        moved = Math.max(moved, Math.hypot(step.motion.tipX - at.x, step.motion.tipY - at.y));
        expect(step.motion.lean).toBe(0);
        if (step.resting && restedAt === null) restedAt = time;
      },
    );
    expect(moved).toBeGreaterThan(1);
    expect(moved).toBeLessThan(pointer.drift.size * 1.5);
    expect(restedAt).not.toBeNull();
    expect(restedAt ?? Number.POSITIVE_INFINITY).toBeLessThan(3);
  });

  it("drifts for as long as it thinks over a picture", () => {
    const at = { x: 400, y: 300 };
    run(
      startMove(restingAt(at), at, 0.45, bounds),
      10,
      60,
      {
        ...thinking,
        driftBudget: Number.POSITIVE_INFINITY,
      },
      (step) => expect(step.resting).toBe(false),
    );
  });
});

describe("a bot pointer under reduced motion", () => {
  it("is at its point at once, upright, and rests", () => {
    const step = stepPointer(far({ x: 100, y: 100 }, { x: 900, y: 600 }), 1 / 60, {
      thinking: true,
      driftBudget: Number.POSITIVE_INFINITY,
      lean: true,
      reduced: true,
    });
    expect(step.arrived).toBe(true);
    expect(step.resting).toBe(true);
    expect({ x: step.motion.tipX, y: step.motion.tipY, lean: step.motion.lean }).toEqual({
      x: 900,
      y: 600,
      lean: 0,
    });
  });
});

describe("a bot pointer's tag", () => {
  const width = 80;

  it("sits to the right and below, and flips away from the right edge and the bottom", () => {
    expect(tagSide({ x: 400, y: 300 }, width, page, [])).toEqual({ x: 1, y: 1 });
    expect(tagSide({ x: page.width - 60, y: 300 }, width, page, [])).toEqual({ x: -1, y: 1 });
    expect(tagSide({ x: 400, y: page.height - 20 }, width, page, [])).toEqual({ x: 1, y: -1 });
  });

  it("flips away from another bot's tag, up or down first", () => {
    const other = { at: { x: 400, y: 300 }, width, side: { x: 1, y: 1 } } as const;
    expect(tagSide({ x: 410, y: 305 }, width, page, [other])).toEqual({ x: 1, y: -1 });
    // With the other above it as well, it goes to the left.
    const above = { at: { x: 410, y: 270 }, width, side: { x: 1, y: 1 } } as const;
    expect(tagSide({ x: 410, y: 305 }, width, page, [other, above]).x).toBe(-1);
  });
});
