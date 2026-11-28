// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DrawnRect, PageSize, Point } from "./browser.ts";

// How a live view draws a picture of the page: resting so it covers the
// view, then zoomed and moved by the person's fingers, or following a bot at
// a size that reads. Zooming changes only the picture on the device,
// never the page, which the bots and the computer see as it is.

/** A size in the view's points. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How far the picture is zoomed, and where its top-left corner sits in the view. */
export interface Zoom {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/** The closest a pinch goes: four times the fitted width. */
export const MAX_ZOOM = 4;

/** The picture's size at no zoom: as wide as the view, as tall as the page's shape makes it. */
export const fitted = (view: Size, page: Size): Size => ({
  width: view.width,
  height: page.width > 0 ? (view.width * page.height) / page.width : 0,
});

/** Where the picture is drawn in the view at `zoom`. */
export const drawnRect = (picture: Size, zoom: Zoom): DrawnRect => ({
  left: zoom.x,
  top: zoom.y,
  width: picture.width * zoom.scale,
  height: picture.height * zoom.scale,
});

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * `zoom` kept over the view: a picture narrower than the view is centered
 * across it, one shorter sits at the top, and a larger one never leaves a
 * gap at an edge it can cover.
 */
export const keptInView = (zoom: Zoom, picture: Size, view: Size): Zoom => {
  const scale = clamp(zoom.scale, 1, MAX_ZOOM);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return {
    scale,
    x: width <= view.width ? (view.width - width) / 2 : clamp(zoom.x, view.width - width, 0),
    y: height <= view.height ? 0 : clamp(zoom.y, view.height - height, 0),
  };
};

/**
 * Where the view rests until the person moves it or it follows a bot. A page
 * of the view's shape, or taller, is fitted to the view's width at its top.
 * One wider than the view's shape, as a computer's page on a phone, is
 * zoomed until it fills the view's height, its middle across in view, so
 * the view is not left mostly empty; the person pinches out to see all of it.
 */
export const restingZoom = (picture: Size, view: Size): Zoom => {
  if (picture.height <= 0 || picture.height >= view.height) {
    return keptInView(NO_ZOOM, picture, view);
  }
  const scale = Math.min(view.height / picture.height, MAX_ZOOM);
  return keptInView({ scale, x: (view.width - picture.width * scale) / 2, y: 0 }, picture, view);
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * The zoom a pinch makes, from `start` when two fingers touched at `from`
 * to where they are now, `to`: the point of the picture between the fingers
 * stays between them, as they spread, close and move together.
 */
export const pinched = (
  start: Zoom,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
): Zoom => {
  const spread = distance(from[0], from[1]);
  const scale = clamp(
    spread > 0 ? (start.scale * distance(to[0], to[1])) / spread : start.scale,
    1,
    MAX_ZOOM,
  );
  const before = middle(from[0], from[1]);
  const after = middle(to[0], to[1]);
  const held = { x: (before.x - start.x) / start.scale, y: (before.y - start.y) / start.scale };
  return { scale, x: after.x - held.x * scale, y: after.y - held.y * scale };
};

/**
 * `start` zoomed by `factor` about `at`, a point of the view, which stays
 * over the same part of the picture: a trackpad's pinch, as two fingers'.
 */
export const zoomedAbout = (start: Zoom, at: Point, factor: number): Zoom => {
  const scale = clamp(start.scale * factor, 1, MAX_ZOOM);
  const held = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale };
  return { scale, x: at.x - held.x * scale, y: at.y - held.y * scale };
};

/** `start` moved by `moved`, as one finger drags a zoomed picture. */
export const dragged = (start: Zoom, moved: Point): Zoom => ({
  scale: start.scale,
  x: start.x + moved.x,
  y: start.y + moved.y,
});

/**
 * The size a followed page reads at, in view points per CSS pixel of the
 * page: a desktop page's text then shows at about the size of a message on
 * a phone.
 */
const READING_POINTS_PER_PIXEL = 0.75;

/** The scale at which `page` reads in `view`: never below the fitted width, nor past the closest zoom. */
export const readingScale = (view: Size, page: PageSize): number =>
  view.width > 0 ? clamp((READING_POINTS_PER_PIXEL * page.width) / view.width, 1, MAX_ZOOM) : 1;

/**
 * The zoom that puts `point`, a point on the page in its CSS pixels, at
 * `at` in `view` (its middle unless given) at `scale`, kept over the view.
 */
export const zoomOn = (
  point: Point,
  scale: number,
  page: PageSize,
  picture: Size,
  view: Size,
  at: Point = { x: view.width / 2, y: view.height / 2 },
): Zoom => {
  const across = page.width > 0 ? point.x / page.width : 0;
  const down = page.height > 0 ? point.y / page.height : 0;
  return keptInView(
    { scale, x: at.x - across * picture.width * scale, y: at.y - down * picture.height * scale },
    picture,
    view,
  );
};

/** How long, in ms, a followed view takes to cover most of the way to where the bot is. */
const FOLLOW_EASE_MS = 450;

/**
 * `from` moved toward `to` over `elapsed` ms, slowing as it nears: the view
 * slides after the bot's pointer instead of jumping to it.
 */
export const easedToward = (from: Zoom, to: Zoom, elapsed: number): Zoom => {
  const step = 1 - Math.exp(-Math.max(elapsed, 0) / FOLLOW_EASE_MS);
  // Close enough to see no difference, it arrives, so the view comes to rest.
  const toward = (a: number, b: number, rest: number) => {
    const next = a + (b - a) * step;
    return Math.abs(b - next) < rest ? b : next;
  };
  return {
    scale: toward(from.scale, to.scale, 0.001),
    x: toward(from.x, to.x, 0.5),
    y: toward(from.y, to.y, 0.5),
  };
};

/** The part of the page in view, as fractions of its width and height: the little map's frame. */
export const seenPart = (zoom: Zoom, picture: Size, view: Size): DrawnRect => {
  const width = picture.width * zoom.scale;
  const height = picture.height * zoom.scale;
  if (width <= 0 || height <= 0) return { left: 0, top: 0, width: 1, height: 1 };
  const left = clamp(-zoom.x / width, 0, 1);
  const top = clamp(-zoom.y / height, 0, 1);
  return {
    left,
    top,
    width: clamp(view.width / width, 0, 1 - left),
    height: clamp(view.height / height, 0, 1 - top),
  };
};

/**
 * One finger's drag of `moved` view points over the zoomed picture: it first
 * moves the person's view of the page, and what reaches the picture's edge
 * scrolls the page itself, as a phone's browser does. `scroll` is in view
 * points, the way the finger went, and zero while the view absorbs it all.
 */
export const draggedView = (
  start: Zoom,
  moved: Point,
  picture: Size,
  view: Size,
): { readonly zoom: Zoom; readonly scroll: Point } => {
  const zoom = keptInView(dragged(start, moved), picture, view);
  return {
    zoom,
    scroll: { x: moved.x - (zoom.x - start.x), y: moved.y - (zoom.y - start.y) },
  };
};
