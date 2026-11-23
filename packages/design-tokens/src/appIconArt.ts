// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The art of the app's icons, the tray's and the favicon's: three bots of an
 * earlier avatar design, side by side, each a flat silhouette with a dot.
 * It is frozen here, values and all, apart from the avatars bots wear now,
 * so the icons stay as they are until they are redrawn for the current
 * design. Only the canvas color behind them follows the tokens.
 */
import type { Themed } from "./tokens.ts";

interface IconPoint {
  readonly x: number;
  readonly y: number;
}

/** One bot of the icon, with its side in px as the first-run screen once drew it. */
export interface IconBot {
  /** SVG path data in a 100 × 100 box. */
  readonly path: string;
  /** The dot's center. */
  readonly mark: IconPoint;
  readonly color: Themed;
  readonly size: number;
}

/** The three bots, left to right, their bottoms aligned, and the gap between them in px. */
export const iconArt: { readonly bots: ReadonlyArray<IconBot>; readonly gap: number } = {
  bots: [
    {
      path: "M60.39 7L82.04 19.5Q92.44 25.5 92.44 37.5L92.44 62.5Q92.44 74.5 82.04 80.5L60.39 93Q50 99 39.61 93L17.96 80.5Q7.56 74.5 7.56 62.5L7.56 37.5Q7.56 25.5 17.96 19.5L39.61 7Q50 1 60.39 7Z",
      mark: { x: 50, y: 50 },
      color: { light: "oklch(0.61 0.102 206)", dark: "oklch(0.708 0.093 189)" },
      size: 36,
    },
    {
      path: "M50 4A46 46 0 1 1 50 96A46 46 0 1 1 50 4Z",
      mark: { x: 50, y: 50 },
      color: { light: "oklch(0.622 0.183 295)", dark: "oklch(0.523 0.148 298)" },
      size: 48,
    },
    {
      path: "M56.88 17.19L91.12 77.81Q98 90 84 90L16 90Q2 90 8.88 77.81L43.12 17.19Q50 5 56.88 17.19Z",
      mark: { x: 50, y: 62 },
      color: { light: "oklch(0.535 0.11 72)", dark: "oklch(0.682 0.132 57)" },
      size: 36,
    },
  ],
  gap: 6,
};

/** The largest bot, which stands for the app where the row would be too small to read: the tray, the smallest icons. */
export const iconLead: IconBot = iconArt.bots.reduce((lead, bot) =>
  bot.size > lead.size ? bot : lead,
);

/** The dot's color over a bot. */
export const iconInk: Themed = { light: "#ffffff", dark: "#0b0b0c" };

/** The dot's radius in the 100-unit box, before `iconDotScale`. */
export const ICON_DOT = 9;

/** How much the dot grows on a bot this many px wide: small ones draw it larger. */
export const iconDotScale = (size: number): number => (size <= 28 ? 1.3 : 1);

/**
 * The tray's badge, on the bot's lower right corner, for a bot this many px
 * wide: its center on the box's diagonal, its radius, and the width of the
 * clear outline that cuts it out of the bot.
 */
export function iconBadge(size: number): {
  readonly center: number;
  readonly r: number;
  readonly cutout: number;
} {
  const r = size <= 28 ? 17 : 14;
  return { center: 100 - r + 2, r, cutout: 6 };
}

/** A row of bots laid out in their own px: each one's box, and the row's size. */
export interface IconLayout {
  readonly width: number;
  readonly height: number;
  readonly placed: ReadonlyArray<{
    readonly bot: IconBot;
    readonly left: number;
    readonly top: number;
  }>;
}

/** `bots` side by side, `gap` px apart, their bottoms aligned. */
export function layOutIcon(bots: ReadonlyArray<IconBot>, gap: number): IconLayout {
  const width = bots.reduce((total, b) => total + b.size, 0) + gap * (bots.length - 1);
  const height = Math.max(...bots.map((b) => b.size));
  let left = 0;
  const placed = bots.map((bot) => {
    const box = { bot, left, top: height - bot.size };
    left += bot.size + gap;
    return box;
  });
  return { width, height, placed };
}
