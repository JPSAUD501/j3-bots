// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTab } from "@j3-bots/contracts";

/** The tab to show first: the one the bot opened or moved in most recently. */
export const frontTab = (tabs: ReadonlyArray<BrowserTab>): BrowserTab | null =>
  tabs.find((tab) => tab.front) ?? null;

/**
 * The site of a page, as a person names it: its host without `www.`. Empty
 * for a tab with no page yet, or an address that is not a web page's.
 */
export const siteOf = (url: string): string => {
  if (!URL.canParse(url)) return "";
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return "";
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
};

/** A point, in whatever units its space has. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a picture of the page is drawn, in the units of the screen that draws it. */
export interface DrawnRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The page's size in CSS pixels, as the media socket's `viewport` frame gives it. */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The point on the page under `point` on the screen, in the page's CSS
 * pixels, or null when it falls outside the picture. The picture is mapped
 * through the page's size, never its own pixels, which are at another scale.
 */
export const pagePoint = (point: Point, drawn: DrawnRect, page: PageSize): Point | null => {
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  const x = (point.x - drawn.left) / drawn.width;
  const y = (point.y - drawn.top) / drawn.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: x * page.width, y: y * page.height };
};

/**
 * The wheel a drag of `moved` on the picture turns, in page CSS pixels: the
 * page follows the finger, so dragging up scrolls down.
 */
export const dragWheel = (moved: Point, drawn: DrawnRect, page: PageSize): Point => {
  const scale = drawn.width > 0 ? page.width / drawn.width : 0;
  return { x: 0 - moved.x * scale, y: 0 - moved.y * scale };
};
