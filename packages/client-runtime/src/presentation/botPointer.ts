// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState } from "@j3-bots/contracts";
import { pointer } from "@j3-bots/design-tokens";
import type { Point } from "./browser.ts";

// A bot's pointer over a page it browses, the same on a phone, on the web
// and on the desktop: how it travels, when its tag shows, and where it steps
// while the person holds the tab. How it looks is `pointer` in the tokens.

/** The two sides a glide bends to, one after the other. */
export type GlideSide = 1 | -1;

/**
 * The control point of a glide from `from` to `to`, which travels a gentle
 * curve and never a straight line: the middle of the move, pushed square to
 * it by `pointer.bend` of its length, to `side`. Take the points in pixels,
 * so the curve bends the same way on a page of any shape.
 */
export function glideBend(from: Point, to: Point, side: GlideSide): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (length === 0) return middle;
  const push = length * pointer.bend * side;
  return { x: middle.x - (dy / length) * push, y: middle.y + (dx / length) * push };
}

/** Where a glide is at `t`, 0 at `from` to 1 at `to`, on its curve through `bend`. */
export function alongGlide(from: Point, bend: Point, to: Point, t: number): Point {
  "worklet";
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * bend.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * bend.y + t * t * to.y,
  };
}

/**
 * Whether a bot's pointer bobs, thinking before it acts: its turn runs and no
 * step of it does, as between one action on the page and the next. Not while
 * the turn may be stalled, which holds still.
 */
export const pointerThinks = (state: BotState): boolean => {
  switch (state._tag) {
    case "thinking":
      return !state.stalled;
    case "working":
      return !state.stalled && state.activityKind === null && state.tool === null;
    default:
      return false;
  }
};

/**
 * How long a pointer's tag stays open from a move or a click, in ms: through
 * the glide, or the face's answer to the click, and `pointer.tagLinger` after.
 */
export const tagOpenFor = (action: "move" | "click", glide: number): number =>
  (action === "click" ? pointer.clickAnswer : glide) + pointer.tagLinger;

/**
 * Where a pointer at `at`, as shares of the page, steps to while the person
 * holds the tab, in pixels from where it points: aside, to where the page has
 * room, so it is out of the person's way.
 */
export const pointerAside = (at: Point): Point => ({
  x: (at.x > 0.6 ? -1 : 1) * pointer.aside.x,
  y: (at.y > 0.6 ? -1 : 1) * pointer.aside.y,
});
