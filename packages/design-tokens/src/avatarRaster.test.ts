// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { avatarMarks, type AvatarMarkName } from "./avatar.ts";
import { drawAvatar } from "./avatarRaster.ts";
import { avatarShapeNames, avatarShapes } from "./avatarShapes.ts";
import { contrastRatio, parseColor } from "./color.ts";
import { Canvas, coverage, flattenPath, mapSubpaths } from "./raster.ts";
import { botPalette } from "./tokens.ts";

const SIZE = 24;
/** Room around the avatar's box, to see anything drawn past it. */
const MARGIN = 4;
const SIDE = SIZE + 2 * MARGIN;

const marks = Object.keys(avatarMarks) as ReadonlyArray<AvatarMarkName>;
const cases = avatarShapeNames.flatMap((shape) => marks.map((mark) => [shape, mark] as const));

const hex = (pixels: Uint8Array, i: number) =>
  `#${Array.from(pixels.subarray(i * 4, i * 4 + 3), (c) => c.toString(16).padStart(2, "0")).join("")}`;

describe.each(["light", "dark"] as const)("a %s still avatar at 24 px", (theme) => {
  it.each(cases)("%s with the %s mark stays inside its box and shows its ink", (shape, mark) => {
    const canvas = new Canvas(SIDE, SIDE);
    const color = "teal";
    drawAvatar(canvas, { shape, color }, { mark, badge: null }, theme, {
      x: MARGIN,
      y: MARGIN,
      size: SIZE,
    });
    const silhouette = coverage(
      mapSubpaths(flattenPath(avatarShapes[shape].path), (p) => ({
        x: MARGIN + (p.x * SIZE) / 100,
        y: MARGIN + (p.y * SIZE) / 100,
      })),
      SIDE,
      SIDE,
    );
    const fill = parseColor(botPalette[color][theme]);
    let inkContrast = 0;
    for (let i = 0; i < SIDE * SIDE; i++) {
      const alpha = canvas.pixels[i * 4 + 3] ?? 0;
      if (alpha === 0) continue;
      const x = i % SIDE;
      const y = Math.floor(i / SIDE);
      // Nothing outside the box, and no ink past the shape's edge.
      expect([x, y].every((c) => c >= MARGIN && c < MARGIN + SIZE)).toBe(true);
      expect(silhouette[i]).toBeGreaterThan(0);
      if (alpha === 255) {
        inkContrast = Math.max(inkContrast, contrastRatio(parseColor(hex(canvas.pixels, i)), fill));
      }
    }
    // The palette promises 3:1 between a bot's color and its ink; some pixel of the mark keeps it.
    expect(inkContrast).toBeGreaterThanOrEqual(3);
  });
});
