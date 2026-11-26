// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Area } from "./window.ts";

// Where the quick access window stands: in the bottom-right corner of the
// display the pointer is on, or where the operator last dragged it on that
// display, always whole on the display's work area. Its place is kept as its
// distance from that corner, so a display whose size changed still has it
// near the corner it was left by.

/** How far the window's right and bottom edges stand from the work area's. */
export interface CornerOffset {
  readonly right: number;
  readonly bottom: number;
}

/**
 * The window's size. With transparency it is larger than the card it shows:
 * the card's rounded corners and its shadow are drawn in the transparent
 * part (`QuickAccess` in the web client lays them out). Without it the
 * window is the card, and nothing shows around it.
 */
export const quickAccessSize = (
  solid: boolean,
): { readonly width: number; readonly height: number } =>
  solid ? { width: 380, height: 580 } : { width: 436, height: 612 };

/**
 * Where a window never placed on a display opens: the card a comfortable gap
 * from the corner. A transparent window carries most of that gap itself, as
 * the room it leaves for the card's shadow.
 */
export const defaultOffset = (solid: boolean): CornerOffset =>
  solid ? { right: 16, bottom: 16 } : { right: 0, bottom: 0 };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/**
 * The window's bounds on a display's work area: `offset` from its bottom-right
 * corner, shrunk to the work area where that is smaller, and moved to lie
 * whole on it.
 */
export const quickAccessBounds = (
  workArea: Area,
  size: { readonly width: number; readonly height: number },
  offset: CornerOffset,
): Area => {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: clamp(
      workArea.x + workArea.width - width - offset.right,
      workArea.x,
      workArea.x + workArea.width - width,
    ),
    y: clamp(
      workArea.y + workArea.height - height - offset.bottom,
      workArea.y,
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
};

/** Where `bounds` stands from the bottom-right corner of `workArea`, as it is kept. */
export const cornerOffset = (workArea: Area, bounds: Area): CornerOffset => ({
  right: Math.round(workArea.x + workArea.width - (bounds.x + bounds.width)),
  bottom: Math.round(workArea.y + workArea.height - (bounds.y + bounds.height)),
});

/** What the global shortcut finds as it is pressed. */
export interface ShortcutMoment {
  /** The page has a primary bot to show. */
  readonly available: boolean;
  /** The window shows. */
  readonly visible: boolean;
  /** The cursor is in it. */
  readonly focused: boolean;
  /** Its page was told to leave, and has not yet. */
  readonly leaving: boolean;
}

/**
 * What the global shortcut does. With nothing to show it shows the main
 * window. Otherwise it opens quick access, and closes it when pressed again;
 * but a quick access the operator put aside to work elsewhere, or one on its
 * way out, comes back to hand instead: they asked for it, not to be rid of it.
 */
export const shortcutStep = (moment: ShortcutMoment): "show-main" | "open" | "return" | "leave" => {
  if (!moment.visible) return moment.available ? "open" : "show-main";
  return moment.leaving || !moment.focused ? "return" : "leave";
};

/** Where the window was last put on a display, by the display's id. */
export interface KeptPlace extends CornerOffset {
  readonly display: string;
}

/** How many displays' places are kept: the ones the window was last put on. */
const KEPT_DISPLAYS = 8;

/** Where the window was last put on `display`, or `null` when it never was. */
export const placeOn = (places: ReadonlyArray<KeptPlace>, display: string): CornerOffset | null => {
  const kept = places.find((place) => place.display === display);
  return kept === undefined ? null : { right: kept.right, bottom: kept.bottom };
};

/**
 * The kept places with `display`'s set to `offset`, the newest last, and the
 * oldest dropped past `KEPT_DISPLAYS`.
 */
export const withPlace = (
  places: ReadonlyArray<KeptPlace>,
  display: string,
  offset: CornerOffset,
): ReadonlyArray<KeptPlace> =>
  [
    ...places.filter((place) => place.display !== display),
    { display, right: offset.right, bottom: offset.bottom },
  ].slice(-KEPT_DISPLAYS);
