// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DrawnRect, Point } from "@j3-bots/client-runtime/presentation";

// How the viewer draws a picture of the page: fitted to the view's width at
// the top, then zoomed and moved by the operator's fingers. Zooming changes
// only the picture on the phone, never the page.

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
const MAX_ZOOM = 4;

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

/** `start` moved by `moved`, as one finger drags a zoomed picture. */
export const dragged = (start: Zoom, moved: Point): Zoom => ({
  scale: start.scale,
  x: start.x + moved.x,
  y: start.y + moved.y,
});
