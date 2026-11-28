// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserInput } from "@j3-bots/contracts";
import { dragWheel, pagePoint, type PageSize, type Point } from "./browser.ts";
import { draggedView, drawnRect, pinched, type Size, type Zoom } from "./browserZoom.ts";

// What fingers on a live view's page do, the same on a phone and in a
// narrow web page: one finger taps to click, holds to right-click, and
// drags to move the person's view of a zoomed page, scrolling the page once
// the view reaches its edge the way the drag started; two fingers pinch the
// view. Moving the view and pinching are only looking: they send the page
// nothing.

/** How far a finger moves before a touch is a drag, not a tap, in view points. */
export const TAP_SLOP = 8;
/** How long a still finger waits before its touch is a right-click. */
export const LONG_PRESS_MS = 500;

/** What the fingers on the page are doing. */
export type PageTouch =
  | { readonly _tag: "none" }
  /** One finger down, not moved past the slop yet. `sliding`: the view was still sliding after a bot. */
  | {
      readonly _tag: "pending";
      readonly start: Point;
      readonly sliding: boolean;
    }
  /**
   * One finger dragging: the view moves, and past its edge the page scrolls,
   * only `along` the way the drag started, so a finger that drifts as it
   * moves the view across does not scroll the page, which would be using it.
   */
  | { readonly _tag: "dragging"; readonly last: Point; readonly along: "x" | "y" }
  /** Two fingers zooming and moving the picture. */
  | { readonly _tag: "pinching"; readonly from: readonly [Point, Point]; readonly zoom: Zoom }
  /** The touch did what it does already, as a long press does; the rest of it does nothing. */
  | { readonly _tag: "spent" };

export const NO_TOUCH: PageTouch = { _tag: "none" };

/** The page as the view draws it when a finger acts. */
export interface TouchScene {
  /** How the picture is drawn now. */
  readonly zoom: Zoom;
  /** The picture's size at no zoom, and the view's; null until both are laid out. */
  readonly picture: Size | null;
  readonly view: Size | null;
  /** The page's size in CSS pixels; null until the server says. */
  readonly page: PageSize | null;
  /** Whether the person's touches reach the page: not while it is frozen or used elsewhere. */
  readonly usable: boolean;
  /** The view still slides after a bot: a tap only stops it. */
  readonly sliding: boolean;
}

/** What a finger's move did. */
export interface TouchStep {
  readonly touch: PageTouch;
  /** Where the person moved their view, which stops following a bot; null when it stays. */
  readonly zoom: Zoom | null;
  /** What goes to the page, in order. */
  readonly send: ReadonlyArray<BrowserInput>;
  /** Where on the view a tap landed, which shows a mark there; null for anything else. */
  readonly tapped: Point | null;
  /** Whether a long press starts its wait now. */
  readonly longPress: boolean;
}

const step = (touch: PageTouch, rest: Partial<Omit<TouchStep, "touch">> = {}): TouchStep => ({
  touch,
  zoom: null,
  send: [],
  tapped: null,
  longPress: false,
  ...rest,
});

/** The page point under `point` on the view, while the picture is laid out. */
const onPage = (point: Point, scene: TouchScene): Point | null =>
  scene.picture === null || scene.page === null
    ? null
    : pagePoint(point, drawnRect(scene.picture, scene.zoom), scene.page);

/** A click at `at` on the page, its pointer first moved there, as a mouse's would be. */
export const clickAt = (
  at: Point,
  button: "left" | "right" | "middle",
): ReadonlyArray<BrowserInput> => {
  const pressed = button === "left" ? 1 : button === "right" ? 2 : 4;
  const pointer = { x: at.x, y: at.y, clickCount: 1, modifiers: 0 } as const;
  return [
    { type: "pointer", action: "move", button: "none", buttons: 0, ...pointer },
    { type: "pointer", action: "down", button, buttons: pressed, ...pointer },
    { type: "pointer", action: "up", button, buttons: 0, ...pointer },
  ];
};

/**
 * A mouse's other button pressed over the page: a click with it where it
 * is, at once, never a touch. Nothing while the page cannot be used.
 */
export const otherButtonAt = (
  point: Point,
  button: "right" | "middle",
  scene: TouchScene,
): ReadonlyArray<BrowserInput> => {
  const at = scene.usable ? onPage(point, scene) : null;
  return at === null ? [] : clickAt(at, button);
};

/**
 * Fingers touched the page; `points` are every finger down now, in view
 * points. A second finger landing starts a pinch where both are.
 */
export const touchStarted = (
  touch: PageTouch,
  points: ReadonlyArray<Point>,
  scene: TouchScene,
): TouchStep => {
  const [first, second] = points;
  if (first === undefined) return step(touch);
  if (second !== undefined) {
    return step({ _tag: "pinching", from: [first, second], zoom: scene.zoom });
  }
  return step(
    { _tag: "pending", start: first, sliding: scene.sliding },
    { longPress: scene.usable && !scene.sliding },
  );
};

/** The fingers on the page moved to `points`. */
export const touchMoved = (
  touch: PageTouch,
  points: ReadonlyArray<Point>,
  scene: TouchScene,
): TouchStep => {
  const [first, second] = points;
  if (first === undefined) return step(touch);
  if (second !== undefined) {
    // A second finger joining a drag starts a pinch where both are now.
    if (touch._tag !== "pinching") {
      return step({ _tag: "pinching", from: [first, second], zoom: scene.zoom });
    }
    return step(touch, { zoom: pinched(touch.zoom, touch.from, [first, second]) });
  }
  switch (touch._tag) {
    case "none":
    case "spent":
    case "pinching":
      // A finger left a pinch: the rest of the touch only lets go.
      return step({ _tag: "spent" });
    case "pending":
      if (Math.hypot(first.x - touch.start.x, first.y - touch.start.y) < TAP_SLOP) {
        return step(touch);
      }
      return step({
        _tag: "dragging",
        last: touch.start,
        along: Math.abs(first.x - touch.start.x) >= Math.abs(first.y - touch.start.y) ? "x" : "y",
      });
    case "dragging": {
      const moved = { x: first.x - touch.last.x, y: first.y - touch.last.y };
      const next: PageTouch = { _tag: "dragging", last: first, along: touch.along };
      if (scene.picture === null || scene.view === null) return step(next);
      const { zoom, scroll: left } = draggedView(scene.zoom, moved, scene.picture, scene.view);
      const scroll = touch.along === "x" ? { x: left.x, y: 0 } : { x: 0, y: left.y };
      // What the view could not take scrolls the page, which is using it.
      const at = onPage(first, scene);
      if (
        !scene.usable ||
        (scroll.x === 0 && scroll.y === 0) ||
        at === null ||
        scene.page === null
      ) {
        return step(next, { zoom });
      }
      const wheel = dragWheel(scroll, drawnRect(scene.picture, scene.zoom), scene.page);
      return step(next, {
        zoom,
        send: [{ type: "wheel", x: at.x, y: at.y, deltaX: wheel.x, deltaY: wheel.y, modifiers: 0 }],
      });
    }
  }
};

/**
 * A finger let go, `remaining` still down. Once the last one does, a tap
 * clicks where it touched, asking first whether that is a field (`probe`),
 * whose answer decides the keyboard; a tap on a view still sliding after a
 * bot only stops it there.
 */
export const touchLifted = (touch: PageTouch, remaining: number, scene: TouchScene): TouchStep => {
  if (remaining > 0) return step({ _tag: "spent" });
  if (touch._tag !== "pending") return step(NO_TOUCH);
  if (touch.sliding) return step(NO_TOUCH, { zoom: scene.zoom });
  const at = scene.usable ? onPage(touch.start, scene) : null;
  if (at === null) return step(NO_TOUCH);
  return step(NO_TOUCH, {
    send: [{ type: "probe", x: at.x, y: at.y }, ...clickAt(at, "left")],
    tapped: touch.start,
  });
};

/** A finger held still for `LONG_PRESS_MS`: a right-click where it is, and the touch is spent. */
export const touchHeld = (touch: PageTouch, scene: TouchScene): TouchStep => {
  if (touch._tag !== "pending" || !scene.usable) return step(touch);
  const at = onPage(touch.start, scene);
  if (at === null) return step(touch);
  return step({ _tag: "spent" }, { send: clickAt(at, "right") });
};
