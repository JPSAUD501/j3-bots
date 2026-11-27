// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES } from "./builtInThemes.ts";
import { parseColor, perceivedDistance, toOklch } from "./color.ts";
import {
  APPEARANCES,
  paletteProblems,
  resolveTheme,
  STATE_ACCENT_DISTANCE,
  type ThemeDefinition,
  type ThemePalettes,
} from "./theme.ts";
import { themeCssProblem } from "./themeCss.ts";
import { stockPalette } from "./tokens.ts";

const resolved = (definition: ThemeDefinition) => {
  const result = resolveTheme(definition);
  if (result._tag === "refused") throw new Error(result.reason);
  return result;
};

const palettesOf = (definition: ThemeDefinition): ThemePalettes => resolved(definition).palettes;

describe.each(BUILT_IN_THEME_IDS)("the built-in %s", (id) => {
  const palettes = palettesOf(BUILT_IN_THEMES[id]);

  it.each(APPEARANCES)("keeps every contrast rule in %s", (appearance) => {
    expect(paletteProblems(palettes[appearance], appearance)).toEqual([]);
  });

  it("is dark in the dark appearance and light in the light one", () => {
    expect(toOklch(palettes.dark.background).l).toBeLessThan(0.3);
    expect(toOklch(palettes.light.background).l).toBeGreaterThan(0.9);
  });

  it("keeps its seeds' look: the canvas exactly, the accent's hue", () => {
    const { canvas, accent } = BUILT_IN_THEMES[id];
    for (const appearance of APPEARANCES) {
      const seed = typeof canvas === "string" ? canvas : canvas[appearance];
      expect(
        perceivedDistance(parseColor(palettes[appearance].background), parseColor(seed), "typical"),
      ).toBeLessThan(0.005);
      const given = toOklch(typeof accent === "string" ? accent : accent[appearance]);
      const shown = toOklch(palettes[appearance].accent);
      if (given.c > 0.02) expect(Math.abs(shown.h - given.h)).toBeLessThan(2);
    }
  });

  it.each(APPEARANCES)(
    "keeps each state apart from the accent, in its own hue, in %s",
    (appearance) => {
      const palette = palettes[appearance];
      const stock = stockPalette(appearance);
      for (const state of ["waiting", "blocked", "success"] as const) {
        expect(
          perceivedDistance(parseColor(palette[state]), parseColor(palette.accent), "typical"),
        ).toBeGreaterThanOrEqual(STATE_ACCENT_DISTANCE);
        const drift = Math.abs(
          ((toOklch(palette[state]).h - toOklch(stock[state]).h + 540) % 360) - 180,
        );
        expect(drift).toBeLessThanOrEqual(12);
      }
    },
  );
});

describe("Palco", () => {
  it("is the stock tokens, role for role", () => {
    const palettes = palettesOf(BUILT_IN_THEMES.palco);
    for (const appearance of APPEARANCES) {
      expect(palettes[appearance]).toEqual(stockPalette(appearance));
    }
  });
});

describe("a theme from one canvas and one accent", () => {
  const theme: ThemeDefinition = { name: "Dusk", canvas: "#1a1426", accent: "#e0a030" };

  it("derives both appearances, keeping the canvas's hue in the light one", () => {
    const { palettes } = resolved(theme);
    const light = toOklch(palettes.light.background);
    expect(light.l).toBeGreaterThan(0.9);
    expect(Math.abs(light.h - toOklch("#1a1426").h)).toBeLessThan(3);
  });

  it("tells what it moved: the accent darkened to read on the light canvas", () => {
    const { adjustments } = resolved(theme);
    const accent = adjustments.find((a) => a.role === "accent" && a.appearance === "light");
    expect(accent?.from).toBe("#e0a030");
    expect(toOklch(accent?.to ?? "#ffffff").l).toBeLessThan(toOklch("#e0a030").l);
    expect(accent?.reason).toMatch(/darker/);
  });
});

describe("an override", () => {
  it("that is too faint is moved until it reads, and said to have moved", () => {
    const result = resolved({
      name: "Faint",
      canvas: { light: "#ffffff", dark: "#000000" },
      accent: { light: "#101012", dark: "#f5f5f6" },
      variants: { dark: { "muted-foreground": "#333333" } },
    });
    const moved = result.adjustments.find((a) => a.role === "muted-foreground");
    expect(moved).toMatchObject({ appearance: "dark", from: "#333333" });
    expect(paletteProblems(result.palettes.dark, "dark")).toEqual([]);
  });

  it("of a role a theme does not set is refused, naming the roles there are", () => {
    const result = resolveTheme({
      name: "Loud",
      canvas: "#101010",
      accent: "#ff0000",
      colors: { waiting: "#ff0000" },
    });
    expect(result).toMatchObject({ _tag: "refused" });
    expect(result._tag === "refused" && result.reason).toMatch(/not a theme role.*background/);
  });

  it("that is not a color is refused", () => {
    expect(
      resolveTheme({
        name: "Typo",
        canvas: "#101010",
        accent: "#ff0000",
        colors: { border: "red" },
      }),
    ).toMatchObject({ _tag: "refused" });
  });
});

describe("seeds", () => {
  it("must be #rrggbb", () => {
    expect(resolveTheme({ name: "Bad", canvas: "black", accent: "#ff0000" })).toMatchObject({
      _tag: "refused",
    });
  });

  it("for the dark appearance must be dark", () => {
    expect(
      resolveTheme({
        name: "Upside",
        canvas: { light: "#ffffff", dark: "#f0f0f0" },
        accent: "#3366ff",
      }),
    ).toMatchObject({ _tag: "refused" });
  });
});

describe("a canvas bots would not read on", () => {
  it("is moved until every bot's color reaches 3:1 on it", () => {
    const result = resolved({
      name: "Murky",
      canvas: { light: "#ffffff", dark: "#000000" },
      accent: { light: "#101012", dark: "#f5f5f6" },
      variants: { dark: { muted: "#4a4a4a" } },
    });
    const muted = result.adjustments.find((a) => a.role === "muted" && a.appearance === "dark");
    expect(muted?.reason).toMatch(/every bot's color/);
    expect(paletteProblems(result.palettes.dark, "dark")).toEqual([]);
  });
});

describe("theme CSS", () => {
  it.each([
    ["@import url(https://example.test/a.css);", /@import/],
    ['body { background: url("https://example.test/p.png"); }', /cannot load/],
    ["body { background: url(//example.test/p.png); }", /cannot load/],
    ["body { background: image-set('a.png' 1x); }", /image-set/],
    ["body { background: u\\72l(https://example.test/p.png); }", /backslash/],
    ['body { background: url("data:image/gif;base64,R0lGOD"); }', /cannot load/],
  ])("refuses what would load a file: %s", (css, reason) => {
    expect(themeCssProblem(css)).toMatch(reason);
  });

  it.each([
    "@keyframes glow { to { opacity: 0.5; } }",
    '[data-slot="bubble"] { animation: glow 2s infinite; }',
    '[data-slot="bubble"]{animation-name:glow}',
    // The app's own keyframes, with a vendor's prefix, or a comment around the name.
    '[data-slot="roster"]{-webkit-animation:spin 1s infinite}',
    "a{/**/animation:spin 1s infinite}",
    "a{animation/**/:spin 1s infinite}",
    'a{content:"/*"}b{animation/**/:spin 1s infinite}',
    "a{b{}animation:spin 1s infinite}",
  ])("refuses what would move on its own: %s", (css) => {
    expect(themeCssProblem(css)).toMatch(/cannot animate/);
  });

  it("takes the theme's own background, references in the page, and transitions", () => {
    expect(
      themeCssProblem(
        '[data-slot="conversation"] { background: var(--theme-background-image) center / cover; }' +
          ' [data-slot="bubble"] { mask: url(#round); transition: background-color 150ms; }',
      ),
    ).toBeNull();
  });
});
