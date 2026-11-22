// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { avatarShapes } from "./avatarShapes.ts";
import {
  contrastRatio,
  inSrgbGamut,
  over,
  parseColor,
  perceivedDistance,
  toSrgb8,
  type LinearRgb,
  type Vision,
} from "./color.ts";
import { renderFontManifest } from "./fontManifest.ts";
import { botPalette, colors, type ColorRole } from "./tokens.ts";
import { renderUniwindCss } from "./uniwind.ts";
import { renderWebCss } from "./web.ts";

const modes = ["light", "dark"] as const;

describe.each([
  ["web.css", renderWebCss],
  ["uniwind.css", renderUniwindCss],
  ["fonts.json", renderFontManifest],
])("generated %s", (file, render) => {
  it("is regenerated after every token change", () => {
    const committed = NodeFS.readFileSync(new URL(`../generated/${file}`, import.meta.url), "utf8");
    // Run `pnpm --filter @j3-bots/design-tokens generate` when this fails.
    expect(committed).toBe(render());
  });
});

describe.each(modes)("%s theme contrast", (mode) => {
  const background = parseColor(colors.background[mode]);
  // Translucent roles are judged as they render: over the canvas.
  const color = (role: ColorRole, base: LinearRgb = background) => {
    const parsed = parseColor(colors[role][mode]);
    return parsed.alpha < 1 ? over(parsed, base) : parsed;
  };

  const text: Array<[ColorRole, ColorRole]> = [
    ["foreground", "background"],
    ["foreground", "surface"],
    ["foreground", "sidebar"],
    ["foreground", "muted"],
    ["foreground", "muted-strong"],
    ["muted-foreground", "background"],
    ["muted-foreground", "surface"],
    ["muted-foreground", "sidebar"],
    ["muted-foreground", "muted"],
    ["muted-foreground", "muted-strong"],
    ["muted-foreground", "bubble-bot"],
    ["bubble-operator-foreground", "bubble-operator"],
    ["bubble-bot-foreground", "bubble-bot"],
    ["accent", "background"],
    ["accent", "surface"],
    ["accent", "sidebar"],
    ["accent", "muted"],
    ["accent-foreground", "accent"],
    ["waiting", "background"],
    ["waiting", "sidebar"],
    ["waiting", "muted"],
    ["waiting", "waiting-surface"],
    ["blocked", "background"],
    ["blocked", "surface"],
    ["blocked", "sidebar"],
    ["blocked", "blocked-surface"],
    ["success", "background"],
    ["success", "surface"],
  ];

  it.each(text)("%s text on %s reaches 4.5:1", (fg, bg) => {
    expect(contrastRatio(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps code readable inside both bubbles", () => {
    for (const [fg, bubble] of [
      ["bubble-bot-foreground", "bubble-bot"],
      ["bubble-operator-foreground", "bubble-operator"],
    ] as const) {
      const code = color("code-background", color(bubble));
      expect(contrastRatio(color(fg), code)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("draws focus rings, state marks and control boundaries at 3:1 against every surface", () => {
    for (const mark of ["accent", "waiting", "blocked", "success", "control-off"] as const) {
      for (const bg of ["background", "surface", "sidebar", "muted"] as const) {
        expect(contrastRatio(color(mark), color(bg))).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe.each(modes)("%s bot palette", (mode) => {
  const entries = Object.entries(botPalette).map(
    ([name, value]) => [name, parseColor(value[mode])] as const,
  );

  it.each(entries)(
    "%s is displayable and reaches 3:1 against the canvases and its ink",
    (_, fill) => {
      expect(inSrgbGamut(fill)).toBe(true);
      for (const role of ["background", "surface", "sidebar", "muted", "avatar-ink"] as const) {
        expect(contrastRatio(fill, parseColor(colors[role][mode]))).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each<Vision>(["typical", "protanopia", "deuteranopia", "tritanopia"])(
    "keeps every pair apart with %s",
    (vision) => {
      const tooClose = entries.flatMap(([a, x], i) =>
        entries
          .slice(i + 1)
          .filter(([, y]) => perceivedDistance(x, y, vision) < 0.085)
          .map(([b]) => `${a}/${b}`),
      );
      expect(tooClose).toEqual([]);
    },
  );
});

describe("8-bit sRGB", () => {
  it("gives back the hex value it was parsed from", () => {
    expect(toSrgb8(parseColor("#fcfcfc"))).toEqual([252, 252, 252]);
    expect(toSrgb8(parseColor("#1a7f37"))).toEqual([26, 127, 55]);
  });

  it("converts OKLCH to the sRGB a browser shows for it", () => {
    // CSS Color 4's reference value for sRGB red.
    expect(toSrgb8(parseColor("oklch(0.62796 0.25768 29.23)"))).toEqual([255, 0, 0]);
  });
});

describe("avatar shapes", () => {
  it.each(Object.entries(avatarShapes))("%s stays inside its 100 × 100 box", (_, shape) => {
    const numbers = (shape.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThan(0);
    // Arc commands carry radii and flags, which are small and non-negative too.
    for (const n of numbers) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
    }
  });
});
