// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { pagePoint } from "./browser.ts";
import {
  draggedView,
  drawnRect,
  fitted,
  followedView,
  keptInSight,
  keptInView,
  NO_ZOOM,
  pinched,
  readingScale,
  restingZoom,
  movedBetween,
  seenPart,
  viewResponseFor,
  zoomedAbout,
  zoomOn,
} from "./browserZoom.ts";
import { pointerBounds, restingAt, startMove, stepPointer } from "./pointerMotion.ts";

// A 1280×800 page on a phone 400 points wide, with 600 points for the picture.
const view = { width: 400, height: 600 };
const page = { width: 1280, height: 800 };
const picture = fitted(view, page);

/** How long, in seconds, a pointer's move answering in `response` takes to arrive, stepped at 60 Hz. */
const stepUntilArrived = (response: number): number => {
  const frame = 1 / 60;
  let motion = startMove(
    restingAt({ x: 100, y: 100 }),
    { x: 500, y: 100 },
    response,
    pointerBounds(page),
  );
  for (let frames = 1; frames < 600; frames += 1) {
    const step = stepPointer(motion, frame, {
      thinking: false,
      driftBudget: 0,
      lean: true,
      reduced: false,
    });
    if (step.arrived) return frames * frame;
    motion = step.motion;
  }
  return Number.POSITIVE_INFINITY;
};

describe("the viewer's zoom", () => {
  it("rests a desktop page filling the phone's height, from its top-left", () => {
    expect(picture).toEqual({ width: 400, height: 250 });
    // 2.4 times the fitted width: 960 by 600, as tall as the view.
    expect(restingZoom(picture, view)).toEqual({ scale: 2.4, x: 0, y: 0 });
  });

  it("rests a page of the view's shape, or taller, fitted to the width at its top", () => {
    const tall = fitted(view, { width: 390, height: 2000 });
    expect(restingZoom(tall, view)).toEqual(NO_ZOOM);
  });

  it("keeps the page point between the fingers under them as they spread", () => {
    const from = [
      { x: 150, y: 100 },
      { x: 250, y: 100 },
    ] as const;
    const to = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ] as const;
    const zoom = pinched(NO_ZOOM, from, to);
    expect(zoom.scale).toBe(2);
    const between = { x: 200, y: 100 };
    expect(pagePoint(between, drawnRect(picture, zoom), page)).toEqual(
      pagePoint(between, drawnRect(picture, NO_ZOOM), page),
    );
  });

  it("zooms a trackpad's pinch about the pointer, within the same bounds", () => {
    const at = { x: 120, y: 80 };
    const zoom = zoomedAbout(NO_ZOOM, at, 2);
    expect(zoom.scale).toBe(2);
    expect(pagePoint(at, drawnRect(picture, zoom), page)).toEqual(
      pagePoint(at, drawnRect(picture, NO_ZOOM), page),
    );
    expect(zoomedAbout(zoom, at, 0.1).scale).toBe(1);
    expect(zoomedAbout(zoom, at, 100).scale).toBe(4);
  });

  it("never zooms out past the fitted width, nor in past four times it", () => {
    const close = [
      { x: 190, y: 100 },
      { x: 210, y: 100 },
    ] as const;
    const apart = [
      { x: 0, y: 100 },
      { x: 400, y: 100 },
    ] as const;
    expect(pinched(NO_ZOOM, apart, close).scale).toBe(1);
    expect(pinched(NO_ZOOM, close, apart).scale).toBe(4);
  });

  it("never leaves a gap at an edge the picture can cover", () => {
    const zoom = keptInView({ scale: 2, x: 50, y: -900 }, picture, view);
    // 800 by 500: wider than the view, shorter than it.
    expect(zoom).toEqual({ scale: 2, x: 0, y: 0 });
    expect(keptInView({ scale: 4, x: -2000, y: -900 }, picture, view)).toEqual({
      scale: 4,
      x: -1200,
      y: -400,
    });
  });
});

describe("following a bot", () => {
  it("reads a desktop page at about a message's size on a phone, and never zooms out past the width", () => {
    expect(readingScale({ width: 360, height: 640 }, page)).toBeCloseTo(2.67, 2);
    expect(readingScale({ width: 1200, height: 800 }, page)).toBe(1);
    expect(readingScale({ width: 100, height: 640 }, page)).toBe(4);
  });

  it("puts the bot's point in the middle of the view, within the page's edges", () => {
    const scale = readingScale(view, page);
    const middle = zoomOn({ x: 640, y: 400 }, scale, page, picture, view);
    const under = pagePoint({ x: 200, y: 300 }, drawnRect(picture, middle), page);
    expect(under?.x).toBeCloseTo(640);
    expect(under?.y).toBeCloseTo(400);
    // A point at the page's corner leaves no gap past it.
    expect(zoomOn({ x: 0, y: 0 }, scale, page, picture, view)).toMatchObject({ x: 0, y: 0 });
  });

  it("keeps the bot's point in sight, moving the view only once it nears an edge", () => {
    const rest = restingZoom(picture, view);
    // At 2.4 times, a page pixel is 0.75 view points: (100, 400) is at (75, 300), in sight.
    expect(keptInSight(rest, { x: 100, y: 400 }, page, picture, view)).toEqual(rest);
    // (1000, 400) is at 750 across, past the view: it comes to 64 points inside its right edge.
    expect(keptInSight(rest, { x: 1000, y: 400 }, page, picture, view)).toEqual({
      scale: 2.4,
      x: -414,
      y: 0,
    });
    // Near the page's own edge, the view stops at it rather than leave a gap.
    expect(keptInSight(rest, { x: 1270, y: 400 }, page, picture, view)).toEqual({
      scale: 2.4,
      x: -560,
      y: 0,
    });
  });

  it("heads from where it rests, then on from where it headed, as the bot points elsewhere", () => {
    const first = followedView(null, { x: 1000, y: 400 }, page, picture, view);
    expect(first).toEqual({ scale: 2.4, x: -414, y: 0 });
    // Back near the page's start, the view moves only as far as keeps it in sight.
    expect(followedView(first, { x: 500, y: 400 }, page, picture, view)).toEqual({
      scale: 2.4,
      x: -311,
      y: 0,
    });
    expect(followedView(first, null, page, picture, view)).toEqual(first);
  });

  it("moves toward the bot on the pointer's spring instead of jumping, and arrives with it", () => {
    const to = { scale: 2.4, x: -400, y: 0 };
    const from = { scale: 2.4, x: 0, y: 0 };
    const response = viewResponseFor(from, to, view);
    const early = movedBetween(from, to, 150, response);
    const late = movedBetween(from, to, 450, response);
    expect(early.x).toBeLessThan(0);
    expect(late.x).toBeLessThan(early.x);
    expect(late.x).toBeGreaterThan(-400);
    // The pointer's move of that length arrives at the same moment.
    const pointer = stepUntilArrived(response);
    expect(movedBetween(from, to, pointer * 1000 - 20, response)).not.toEqual(to);
    expect(movedBetween(from, to, pointer * 1000 + 20, response)).toEqual(to);
  });

  it("shows on the little map which part of the page is in view", () => {
    expect(seenPart(NO_ZOOM, picture, view)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    expect(seenPart({ scale: 2, x: -400, y: -100 }, picture, view)).toEqual({
      left: 0.5,
      top: 0.2,
      width: 0.5,
      height: 0.8,
    });
  });
});

describe("dragging a zoomed page", () => {
  // 1200 by 750 in a 400 by 600 view.
  const zoomed = { scale: 3, x: -400, y: 0 };

  it("moves the person's view first, and scrolls nothing while the view takes it", () => {
    const { zoom, scroll } = draggedView(zoomed, { x: 100, y: 0 }, picture, view);
    expect(zoom.x).toBe(-300);
    expect(scroll).toEqual({ x: 0, y: 0 });
  });

  it("scrolls the page with what passes the picture's edge", () => {
    // 150 more of the picture fits up; the other 10 scroll the page.
    const { zoom, scroll } = draggedView(zoomed, { x: 0, y: -160 }, picture, view);
    expect(zoom.y).toBe(-150);
    expect(scroll).toEqual({ x: 0, y: -10 });
  });
});
