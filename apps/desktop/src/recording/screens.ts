// SPDX-License-Identifier: AGPL-3.0-or-later

// Where a point on the desktop lands in a recording: which screen, and where
// in that screen's video. Each screen is recorded whole into a video of its
// own, scaled down to fit HD, so a point in the desktop's coordinates (the
// system's logical pixels, Electron's `Display.bounds`) maps to the video's
// pixels by that screen's scale alone.

/** The largest video a screen is recorded at: HD, its own shape kept. */
const VIDEO_BOX = { width: 1280, height: 720 } as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A recorded screen: its place on the desktop, and the size of its video. */
export interface RecordedScreen {
  readonly screen: number;
  readonly bounds: Rect;
  readonly video: Size;
}

/** A point as it lands in a recording. */
export interface Located {
  readonly screen: number;
  /** In the screen's video pixels, from its top left. */
  readonly x: number;
  readonly y: number;
  /** Across the screen, from 0 (left, top) to 1 (right, bottom). */
  readonly nx: number;
  readonly ny: number;
}

const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/**
 * The size a screen of `pixels` is recorded at: within `VIDEO_BOX` turned
 * the screen's way (a portrait screen fits 720 by 1280), its shape kept,
 * never larger than the screen, each side even as H.264 needs.
 */
export const videoSize = (pixels: Size): Size => {
  const portrait = pixels.height > pixels.width;
  const box = portrait ? { width: VIDEO_BOX.height, height: VIDEO_BOX.width } : VIDEO_BOX;
  const scale = Math.min(1, box.width / pixels.width, box.height / pixels.height);
  return { width: even(pixels.width * scale), height: even(pixels.height * scale) };
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** How far `point` is from `rect`, 0 inside it. */
const distance = (point: { readonly x: number; readonly y: number }, rect: Rect) => {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
};

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Where `point`, in the desktop's coordinates, lands: on the screen that
 * holds it, or the nearest one for a point between screens, clamped to its
 * edge. `null` when nothing is recorded.
 */
export const locate = (
  point: { readonly x: number; readonly y: number },
  screens: ReadonlyArray<RecordedScreen>,
): Located | null => {
  let best: RecordedScreen | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of screens) {
    const away = distance(point, candidate.bounds);
    if (away < bestDistance) {
      best = candidate;
      bestDistance = away;
    }
  }
  if (best === null) return null;
  const { bounds, video } = best;
  const nx = clamp((point.x - bounds.x) / bounds.width, 0, 1);
  const ny = clamp((point.y - bounds.y) / bounds.height, 0, 1);
  return {
    screen: best.screen,
    x: clamp(Math.round(nx * video.width), 0, video.width - 1),
    y: clamp(Math.round(ny * video.height), 0, video.height - 1),
    nx: round(nx, 4),
    ny: round(ny, 4),
  };
};
