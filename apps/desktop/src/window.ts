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

/** How much of `a` lies on `b`, in square pixels. */
const overlap = (a: Area, b: Area) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/**
 * Where the window opens: where it closed, moved and shrunk as needed to lie
 * whole on the work area of the display it overlaps most, so its title bar
 * is always within reach. When it overlaps no display the system has now, at
 * its default size, placed by the system.
 */
export const openingBounds = (
  saved: WindowState | null,
  displays: ReadonlyArray<Area>,
): {
  readonly bounds: Partial<Area> & { width: number; height: number };
  readonly maximized: boolean;
} => {
  if (saved === null) return { bounds: DEFAULT_SIZE, maximized: false };
  const best = displays.reduce<{ area: Area; shared: number } | null>((found, area) => {
    const shared = overlap(saved, area);
    return shared > (found?.shared ?? 0) ? { area, shared } : found;
  }, null);
  if (best === null) return { bounds: DEFAULT_SIZE, maximized: saved.maximized };
  const { area } = best;
  const width = clamp(saved.width, MIN_SIZE.width, area.width);
  const height = clamp(saved.height, MIN_SIZE.height, area.height);
  return {
    bounds: {
      x: clamp(saved.x, area.x, area.x + area.width - width),
      y: clamp(saved.y, area.y, area.y + area.height - height),
      width,
      height,
    },
    maximized: saved.maximized,
  };
};
