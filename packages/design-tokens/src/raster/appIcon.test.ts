// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { iconArt } from "../appIconArt.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import { colors } from "../tokens.ts";
import { desktopIcon, renderAppIcon, renderTrayIcon, type AppIcon } from "./appIcon.ts";
import { readPng } from "./readPng.ts";

const rgb = (value: string) => toSrgb8(parseColor(value));
const near = (pixel: ReadonlyArray<number>, color: ReadonlyArray<number>) =>
  Math.hypot(...[0, 1, 2].map((c) => (pixel[c] ?? 0) - (color[c] ?? 0))) < 40;

/** Every pixel of a PNG, with where it is. */
const pixelsOf = (png: Uint8Array<ArrayBuffer>) => {
  const { width, height, rgba } = readPng(png);
  return Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return { x, y, rgba: rgba(x, y) };
  });
};

/** The plate over the whole image, its square the image's own. */
const onSquare = (size: number): AppIcon => ({
  size,
  plate: { kind: "square" },
  framing: "plate",
  width: 1,
});

/** The mark alone, its plate's square the image's own. */
const alone = (size: number): AppIcon => ({ ...onSquare(size), plate: { kind: "none" } });

/** Where the large drawing puts a point of the letters' units, on a plate `size` px square. */
const onLargePlate = (size: number, x: number, y: number) => {
  const { fit } = iconArt.drawings.at(-1) ?? iconArt.drawings[0];
  return {
    x: Math.floor((50 + (x - iconArt.middle.x) * fit) * (size / 100)),
    y: Math.floor((50 + (y - iconArt.middle.y) * fit) * (size / 100)),
  };
};

describe("renderAppIcon", () => {
  it("draws each smaller size with more of its plate in letters, down to 16 px", () => {
    const lettered = [16, 24, 32, 48, 64].map((size) => {
      const letters = pixelsOf(renderAppIcon(onSquare(size))).filter((p) =>
        near(p.rgba, rgb(iconArt.ink.dark)),
      );
      return letters.length / (size * size);
    });
    expect(lettered).toEqual([...lettered].sort((a, b) => b - a));
    // The smallest is drawn far heavier than the large drawing, not a little.
    expect((lettered[0] ?? 0) / (lettered[4] ?? 1)).toBeGreaterThan(1.3);
  });

  it("glows around the light from the large drawing up, and not below it", () => {
    // Left of the light, halfway out of its glow, where no letter is; and the
    // same row at the plate's far edge, which is the plate alone.
    const blueOver = (size: number) => {
      const { rgba } = readPng(renderAppIcon(onSquare(size)));
      const { x, y } = onLargePlate(size, iconArt.light.x - 12, iconArt.light.y);
      return (rgba(x, y)[2] ?? 0) - (rgba(size - 1, y)[2] ?? 0);
    };
    expect(blueOver(256)).toBeGreaterThan(20);
    expect(blueOver(48)).toBe(0);
  });

  it("glows on a dark ground only, where there is no plate", () => {
    const size = 256;
    const { x, y } = onLargePlate(size, iconArt.light.x - 12, iconArt.light.y);
    const alpha = (theme: "light" | "dark") =>
      readPng(renderAppIcon({ ...alone(size), theme })).rgba(x, y)[3];
    expect(alpha("dark")).toBeGreaterThan(30);
    expect(alpha("light")).toBe(0);
  });

  it("as a silhouette, is white wherever it is drawn, its light too", () => {
    const size = 256;
    const png = renderAppIcon({ ...alone(size), mark: "silhouette" });
    const drawn = pixelsOf(png).filter((p) => (p.rgba[3] ?? 0) > 0);
    expect(drawn.every((p) => near(p.rgba, [255, 255, 255]))).toBe(true);
    const light = onLargePlate(size, iconArt.light.x, iconArt.light.y);
    expect(readPng(png).rgba(light.x, light.y)[3]).toBe(255);
    // Its only soft pixels are its edges: no glow is left around the light.
    const glow = onLargePlate(size, iconArt.light.x - 12, iconArt.light.y);
    expect(readPng(png).rgba(glow.x, glow.y)[3]).toBe(0);
  });

  it("spans the share asked with the mark alone, centered, where the mark is framed", () => {
    const size = 200;
    const drawn = pixelsOf(
      renderAppIcon({ ...alone(size), framing: "mark", width: 0.5, mark: "silhouette" }),
    ).filter((p) => (p.rgba[3] ?? 0) > 127);
    const xs = drawn.map((p) => p.x);
    const ys = drawn.map((p) => p.y);
    const [left, right, top, bottom] = [
      Math.min(...xs),
      Math.max(...xs) + 1,
      Math.min(...ys),
      Math.max(...ys) + 1,
    ];
    // The longer side spans 100 px, and the shorter is centered in them.
    expect(Math.abs(Math.max(right - left, bottom - top) - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs((left + right) / 2 - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs((top + bottom) / 2 - 100)).toBeLessThanOrEqual(1);
  });

  it("shades the plate across its own square, and keeps its end colors past it", () => {
    // An adaptive icon's background: a 108 px layer whose plate is the middle 86.
    const { rgba } = readPng(
      renderAppIcon({
        size: 108,
        plate: { kind: "square" },
        framing: "plate",
        width: 86 / 108,
        mark: "none",
      }),
    );
    const top = [...rgb(iconArt.plate.top), 255];
    const bottom = [...rgb(iconArt.plate.bottom), 255];
    expect([rgba(54, 0), rgba(54, 10)]).toEqual([top, top]);
    expect([rgba(54, 97), rgba(54, 107)]).toEqual([bottom, bottom]);
    const middle = rgba(54, 54)[0] ?? 0;
    expect(middle).toBeLessThan(top[0] ?? 0);
    expect(middle).toBeGreaterThan(bottom[0] ?? 0);
    // Nothing is drawn over it: every row is one color.
    for (const y of [20, 54, 90]) {
      expect(Array.from({ length: 108 }, (_, x) => rgba(x, y)[0])).toEqual(
        Array.from({ length: 108 }, () => rgba(0, y)[0]),
      );
    }
  });

  it("keeps the mark inside the middle 80% circle, which a maskable icon is sure of", () => {
    const size = 200;
    const drawn = pixelsOf(renderAppIcon({ ...alone(size), mark: "silhouette" })).filter(
      (p) => (p.rgba[3] ?? 0) > 0,
    );
    const reach = Math.max(...drawn.map((p) => Math.hypot(p.x + 0.5 - 100, p.y + 0.5 - 100)));
    expect(reach).toBeLessThan(0.4 * size);
  });

  it("fills a small desktop icon with its plate, and leaves a margin around a large one", () => {
    const alpha = (size: number, x: number, y: number) =>
      readPng(renderAppIcon(desktopIcon(size))).rgba(x, y)[3];
    // 16 px: the plate reaches the edge, and only its rounded corner is clear.
    expect([alpha(16, 8, 0), alpha(16, 0, 8), alpha(16, 0, 0)]).toEqual([255, 255, 0]);
    // 64 px: a sixteenth, 4 px, is clear on every edge.
    expect([alpha(64, 32, 2), alpha(64, 2, 32), alpha(64, 32, 5)]).toEqual([0, 0, 255]);
  });
});

describe("renderTrayIcon", () => {
  describe.each([16, 24])("at %s px", (size) => {
    describe.each(["light", "dark"] as const)("in %s", (theme) => {
      const rest = pixelsOf(renderTrayIcon(false, theme, size));
      const attention = pixelsOf(renderTrayIcon(true, theme, size));

      it("changes far more than the light's color when something waits", () => {
        const light = rest.filter(
          (p) => (p.rgba[3] ?? 0) > 127 && near(p.rgba, rgb(iconArt.light.bright[theme])),
        );
        const changed = rest.filter((p, i) => {
          const after = attention[i]?.rgba ?? [];
          return p.rgba.some((value, c) => Math.abs(value - (after[c] ?? 0)) > 24);
        });
        // Recoloring the light alone would change no more than the light.
        expect(light.length).toBeGreaterThan(0);
        expect(changed.length).toBeGreaterThan(2 * light.length);
      });

      it("keeps the letters where they were", () => {
        const below = (pixels: typeof rest) => pixels.filter((p) => p.y >= size * 0.6);
        expect(below(attention)).toEqual(below(rest));
      });

      it("holds the grown light whole", () => {
        const waiting = rgb(colors.waiting[theme]);
        const lit = attention.filter((p) => (p.rgba[3] ?? 0) > 127 && near(p.rgba, waiting));
        const span = (values: ReadonlyArray<number>) => Math.max(...values) - Math.min(...values);
        const wide = span(lit.map((p) => p.x));
        // Cut off at the image's edge, the disc would be shorter than it is wide.
        expect(Math.abs(wide - span(lit.map((p) => p.y)))).toBeLessThanOrEqual(1);
        // And it is the grown one: wider than the light at rest.
        const before = rest.filter(
          (p) => (p.rgba[3] ?? 0) > 127 && near(p.rgba, rgb(iconArt.light.bright[theme])),
        );
        expect(wide).toBeGreaterThan(span(before.map((p) => p.x)));
      });
    });
  });

  it("takes the drawing of its size on screen, on a screen of two pixels to the px", () => {
    const lettered = (png: Uint8Array<ArrayBuffer>) => {
      const pixels = pixelsOf(png);
      return pixels.filter((p) => (p.rgba[3] ?? 0) > 127).length / pixels.length;
    };
    // 16 px at two pixels to the px is the 16 px drawing, heavier than the 32 px one.
    expect(lettered(renderTrayIcon(false, "dark", 16, 2))).toBeGreaterThan(
      lettered(renderTrayIcon(false, "dark", 32)) * 1.05,
    );
  });
});
