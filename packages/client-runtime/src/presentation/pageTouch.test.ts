// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { NO_ZOOM } from "./browserZoom.ts";
import {
  clickAt,
  NO_TOUCH,
  otherButtonAt,
  type TouchScene,
  touchHeld,
  touchLifted,
  touchMoved,
  touchStarted,
} from "./pageTouch.ts";
import { claimsSwipe, swipeDirection } from "./sideSwipe.ts";

// A 1600 × 2400 page in a 400 × 600 view: at no zoom, a view point is four page pixels.
const scene: TouchScene = {
  zoom: NO_ZOOM,
  picture: { width: 400, height: 600 },
  view: { width: 400, height: 600 },
  page: { width: 1600, height: 2400 },
  usable: true,
  sliding: false,
};
const zoomed: TouchScene = { ...scene, zoom: { scale: 2, x: -200, y: 0 } };

describe("a finger on the page", () => {
  it("taps to click, asking first whether it lands in a field", () => {
    const down = touchStarted(NO_TOUCH, [{ x: 100, y: 100 }], scene);
    expect(down.longPress).toBe(true);
    const up = touchLifted(down.touch, 0, scene);
    expect(up.send).toEqual([
      { type: "probe", x: 400, y: 400 },
      ...clickAt({ x: 400, y: 400 }, "left"),
    ]);
    expect(up.tapped).toEqual({ x: 100, y: 100 });
  });

  it("only stops a view still sliding after a bot", () => {
    const sliding = { ...zoomed, sliding: true };
    const down = touchStarted(NO_TOUCH, [{ x: 100, y: 100 }], sliding);
    expect(down.longPress).toBe(false);
    const up = touchLifted(down.touch, 0, sliding);
    expect(up.send).toEqual([]);
    expect(up.zoom).toEqual(sliding.zoom);
  });

  it("clicks a mouse's other button where it is, with that button", () => {
    expect(otherButtonAt({ x: 100, y: 100 }, "middle", zoomed)).toEqual(
      clickAt({ x: 600, y: 200 }, "middle"),
    );
    expect(otherButtonAt({ x: 100, y: 100 }, "right", { ...scene, usable: false })).toEqual([]);
  });

  it("sends nothing to a page it cannot use", () => {
    const frozen = { ...scene, usable: false };
    const down = touchStarted(NO_TOUCH, [{ x: 100, y: 100 }], frozen);
    expect(down.longPress).toBe(false);
    expect(touchLifted(down.touch, 0, frozen).send).toEqual([]);
  });

  it("moves the zoomed view before it scrolls the page", () => {
    let touch = touchStarted(NO_TOUCH, [{ x: 200, y: 300 }], zoomed).touch;
    touch = touchMoved(touch, [{ x: 220, y: 300 }], zoomed).touch;
    const moved = touchMoved(touch, [{ x: 300, y: 300 }], zoomed);
    expect(moved.zoom).toEqual({ scale: 2, x: -100, y: 0 });
    expect(moved.send).toEqual([]);
    expect(touchLifted(moved.touch, 0, zoomed).send).toEqual([]);
  });

  it("scrolls the page with what the view's edge does not take", () => {
    const atEdge: TouchScene = { ...zoomed, zoom: { scale: 2, x: 0, y: 0 } };
    let touch = touchStarted(NO_TOUCH, [{ x: 200, y: 300 }], atEdge).touch;
    touch = touchMoved(touch, [{ x: 220, y: 300 }], atEdge).touch;
    const moved = touchMoved(touch, [{ x: 300, y: 300 }], atEdge);
    expect(moved.zoom).toEqual({ scale: 2, x: 0, y: 0 });
    // 100 view points at twice the fitted width are 200 page pixels, the way the finger went.
    expect(moved.send).toEqual([
      { type: "wheel", x: 600, y: 600, deltaX: -200, deltaY: 0, modifiers: 0 },
    ]);
  });

  it("right-clicks once held still, and the rest of the touch does nothing", () => {
    const down = touchStarted(NO_TOUCH, [{ x: 100, y: 100 }], scene);
    const held = touchHeld(down.touch, scene);
    expect(held.send).toEqual(clickAt({ x: 400, y: 400 }, "right"));
    expect(touchLifted(held.touch, 0, scene).send).toEqual([]);
  });
});

describe("two fingers on the page", () => {
  it("pinch the view and send the page nothing", () => {
    const one = touchStarted(NO_TOUCH, [{ x: 150, y: 300 }], scene);
    const two = touchStarted(
      one.touch,
      [
        { x: 150, y: 300 },
        { x: 250, y: 300 },
      ],
      scene,
    );
    const spread = touchMoved(
      two.touch,
      [
        { x: 100, y: 300 },
        { x: 300, y: 300 },
      ],
      scene,
    );
    expect(spread.zoom?.scale).toBe(2);
    expect(spread.send).toEqual([]);
    // Lifting one finger and then the other ends the pinch with no tap.
    const first = touchLifted(spread.touch, 1, scene);
    expect(first.send).toEqual([]);
    expect(touchLifted(first.touch, 0, scene).send).toEqual([]);
  });
});

describe("a swipe over the bar", () => {
  it("is taken only once the finger goes clearly sideways", () => {
    expect(claimsSwipe(20, 5)).toBe(true);
    expect(claimsSwipe(20, 15)).toBe(false);
    expect(claimsSwipe(10, 0)).toBe(false);
  });

  it("goes toward the end when the finger goes toward the start, and counts when far or quick", () => {
    expect(swipeDirection(-80, 400, false)).toBe(1);
    expect(swipeDirection(80, 400, false)).toBe(-1);
    expect(swipeDirection(-80, 400, true)).toBe(-1);
    expect(swipeDirection(-40, 400, false)).toBeNull();
    expect(swipeDirection(-40, 50, false)).toBe(1);
  });
});
