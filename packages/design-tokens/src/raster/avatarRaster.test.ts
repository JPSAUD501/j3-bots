// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { avatarMarkNames, avatarProportions } from "../avatar.ts";
import { avatarShapeNames, avatarShapes } from "../avatarShapes.ts";
import { contrastRatio, parseColor, toSrgb8 } from "../color.ts";
import { botPalette, colors } from "../tokens.ts";
import { drawAvatar, renderStillAvatar, renderStillRoomAvatar } from "./avatarRaster.ts";
import { Canvas, coverage, flattenPath, mapSubpaths } from "./canvas.ts";

const SIZE = 24;
/** Room around the avatar's box, to see anything drawn past it. */
const MARGIN = 4;
const SIDE = SIZE + 2 * MARGIN;

const cases = avatarShapeNames.flatMap((shape) =>
  avatarMarkNames.map((mark) => [shape, mark] as const),
);

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

/** The shape's coverage of each pixel, for an avatar drawn at the canvas's origin `size` px wide. */
const silhouetteAt = (shape: keyof typeof avatarShapes, size: number) =>
  coverage(
    mapSubpaths(flattenPath(avatarShapes[shape].path), (p) => ({
      x: (p.x * size) / 100,
      y: (p.y * size) / 100,
    })),
    size,
    size,
  );

describe("a still avatar with a badge, on a clear canvas", () => {
  it("leaves the badge's cutout clear over the shape, and the badge and the shape opaque", () => {
    const size = 96;
    const canvas = new Canvas(size, size);
    drawAvatar(
      canvas,
      { shape: "square", color: "teal" },
      { mark: "dot", badge: "waiting" },
      "light",
      {
        x: 0,
        y: 0,
        size,
      },
    );
    const { badge } = avatarProportions(size);
    const unit = size / 100;
    const center = badge.center * unit;
    const inner = (badge.r - badge.cutout / 2) * unit;
    const outer = (badge.r + badge.cutout / 2) * unit;
    const silhouette = silhouetteAt("square", size);
    const alpha = (x: number, y: number) => canvas.pixels[(y * size + x) * 4 + 3];
    let cutout = 0;
    let shape = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        if (d < inner - 1) expect(alpha(x, y)).toBe(255);
        if (silhouette[y * size + x] !== 1) continue;
        if (d > inner + 1 && d < outer - 1) {
          expect(alpha(x, y)).toBe(0);
          cutout++;
        } else if (d > outer + 1) {
          expect(alpha(x, y)).toBe(255);
          shape++;
        }
      }
    }
    // The ring crosses the shape, so the assertions above saw it.
    expect(cutout).toBeGreaterThan(50);
    expect(shape).toBeGreaterThan(1000);
  });
});

describe("the dotted mark at 96 px", () => {
  it("shows six dots around its ring, with the shape's color between them", () => {
    const size = 96;
    const canvas = new Canvas(size, size);
    drawAvatar(
      canvas,
      { shape: "circle", color: "teal" },
      { mark: "dotted", badge: null },
      "light",
      {
        x: 0,
        y: 0,
        size,
      },
    );
    const fill = toSrgb8(parseColor(botPalette.teal.light));
    const ink = toSrgb8(parseColor(colors["avatar-ink"].light));
    const distance = (pixel: ArrayLike<number>, color: ArrayLike<number>) =>
      Math.hypot(...[0, 1, 2].map((c) => (pixel[c] ?? 0) - (color[c] ?? 0)));
    // Walk the ring the mark is drawn on, noting at each step whether the pixel is nearer the ink.
    const center = (avatarShapes.circle.mark.x * size) / 100;
    const radius = (12 * size) / 100;
    const steps = 720;
    const inked = Array.from({ length: steps }, (_, i) => {
      const angle = (2 * Math.PI * i) / steps;
      const x = Math.floor(center + radius * Math.cos(angle));
      const y = Math.floor(center + radius * Math.sin(angle));
      const pixel = canvas.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 3);
      return distance(pixel, ink) < distance(pixel, fill);
    });
    const dots = inked.filter((on, i) => on && !inked.at(i - 1)).length;
    expect(dots).toBe(6);
  });
});

describe("renderStillAvatar", () => {
  it("writes a PNG of the size asked, whose image data holds every pixel", () => {
    const size = 40;
    const png = renderStillAvatar(
      { shape: "hexagon", color: "orange" },
      { mark: "check", badge: "unread" },
      "dark",
      size,
    );
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(png.buffer, png.byteOffset);
    // The first chunk is the header: its width and height, then 8 bits per channel of RGBA.
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([size, size, 8, 6]);
    const idat = 8 + 25;
    const length = view.getUint32(idat);
    expect(new TextDecoder().decode(png.subarray(idat + 4, idat + 8))).toBe("IDAT");
    const rows = inflateSync(png.subarray(idat + 8, idat + 8 + length));
    // Each row is its filter byte, then four bytes a pixel.
    expect(rows.length).toBe(size * (1 + size * 4));
  });

  it.each([30.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a size of %s px",
    (size) => {
      expect(() =>
        renderStillAvatar(
          { shape: "circle", color: "teal" },
          { mark: "dot", badge: null },
          "light",
          size,
        ),
      ).toThrow(RangeError);
    },
  );
});

describe("renderStillRoomAvatar", () => {
  it("cuts the front member's shape out of the one behind it, as a room shows on a page", () => {
    const size = 100;
    const png = renderStillRoomAvatar(
      [
        { shape: "square", color: "teal" },
        { shape: "square", color: "orange" },
      ],
      "light",
      size,
    );
    const view = new DataView(png.buffer, png.byteOffset);
    const idat = 8 + 25;
    const rows = inflateSync(png.subarray(idat + 8, idat + 8 + view.getUint32(idat)));
    // Each row is its filter byte, then four bytes a pixel.
    const pixel = (x: number, y: number) => {
      const at = y * (1 + size * 4) + 1 + x * 4;
      return Array.from(rows.subarray(at, at + 4));
    };
    const opaque = (color: "teal" | "orange") => [
      ...toSrgb8(parseColor(botPalette[color].light)),
      255,
    ];
    // The front square's left edge is at 36.8 px; the back one runs to 63.2 px.
    expect(pixel(30, 50)).toEqual(opaque("teal"));
    expect(pixel(35, 50)[3]).toBe(0);
    expect(pixel(50, 50)).toEqual(opaque("orange"));
  });
});
