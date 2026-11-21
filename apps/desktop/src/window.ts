// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WindowState } from "./settings.ts";

/** A rectangle on the screen, as Electron gives a display's work area. */
export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The window's size on a first launch, or when its place is on a display that is gone. */
const DEFAULT_SIZE = { width: 1200, height: 800 } as const;
export const MIN_SIZE = { width: 480, height: 400 } as const;

/** How much of the window must lie on a display for its saved place to be used. */
const VISIBLE = 64;

const overlap = (a: Area, b: Area) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >= VISIBLE &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= VISIBLE;

/**
 * Where the window opens: where it closed, while enough of that place is on
 * a display the system has now; otherwise at its default size, placed by the
 * system.
 */
export const openingBounds = (
  saved: WindowState | null,
  displays: ReadonlyArray<Area>,
): {
  readonly bounds: Partial<Area> & { width: number; height: number };
  readonly maximized: boolean;
} => {
  if (saved !== null && displays.some((display) => overlap(saved, display))) {
    const { maximized, ...bounds } = saved;
    return {
      bounds: {
        ...bounds,
        width: Math.max(bounds.width, MIN_SIZE.width),
        height: Math.max(bounds.height, MIN_SIZE.height),
      },
      maximized,
    };
  }
  return { bounds: DEFAULT_SIZE, maximized: saved?.maximized ?? false };
};
