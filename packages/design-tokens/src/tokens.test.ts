// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { avatarShapes } from "./avatarShapes.ts";
import {
  contrastRatio,
  inSrgbGamut,
  mixOklab,
  over,
  parseColor,
  perceivedDistance,
  toSrgb8,
  type LinearRgb,
} from "./color.ts";
import {
  avatarEye,
  botBubble,
  botLittle,
  botPalette,
  littleFailed,
  rowLightColors,
} from "./botPalette.ts";
import { renderFontManifest } from "./fontManifest.ts";
import { botColors } from "./names.ts";
import { colors, type ColorRole, glideFor, motion, typeScale, type TypeInput } from "./tokens.ts";
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
    for (const mark of [
      "accent",
      "waiting",
      "blocked",
      "success",
      "control-on",
      "control-off",
    ] as const) {
      for (const bg of ["background", "surface", "sidebar", "muted"] as const) {
        expect(contrastRatio(color(mark), color(bg))).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the image viewer's text readable on its canvas", () => {
    const canvas = color("viewer");
    for (const role of ["viewer-foreground", "viewer-muted-foreground"] as const) {
      expect(contrastRatio(color(role, canvas), canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("sets a switch's thumb apart from its track at 3:1, on and off", () => {
    for (const track of ["control-on", "control-off"] as const) {
      expect(contrastRatio(color("control-thumb"), color(track))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe.each(modes)("%s bot palette", (mode) => {
  const entries = Object.entries(botPalette).map(
    ([name, value]) => [name, parseColor(value[mode])] as const,
  );

  it.each(entries)(
    // The surface is also under the composer, whose border takes the bot's color while focused.
    "%s is displayable and reaches 3:1 against the canvases and its ink",
    (_, fill) => {
      expect(inSrgbGamut(fill)).toBe(true);
      for (const role of ["background", "surface", "sidebar", "muted", "avatar-ink"] as const) {
        expect(contrastRatio(fill, parseColor(colors[role][mode]))).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("keeps every pair apart for typical vision", () => {
    const tooClose = entries.flatMap(([a, x], i) =>
      entries
        .slice(i + 1)
        .filter(([, y]) => perceivedDistance(x, y, "typical") < 0.085)
        .map(([b]) => `${a}/${b}`),
    );
    expect(tooClose).toEqual([]);
  });
});

describe.each(modes)("%s status light", (mode) => {
  it.each(["waiting", "blocked", "foreground"] as const)(
    "%s stands apart from every body through its cutout, at 3:1 on each side",
    (light) => {
      const lamp = parseColor(colors[light][mode]);
      for (const ground of ["background", "surface", "sidebar", "muted"] as const) {
        const cut = parseColor(colors[ground][mode]);
        for (const body of Object.values(botPalette)) {
          const apart = Math.min(
            contrastRatio(lamp, cut),
            contrastRatio(cut, parseColor(body[mode])),
          );
          expect(apart).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );
});

describe.each(modes)("%s little ones", (mode) => {
  const canvases = ["background", "surface", "sidebar", "muted"] as const;

  it.each(botColors)("a %s bot's is its own color made lighter, and displayable", (color) => {
    const body = parseColor(botLittle(color)[mode]);
    const bot = parseColor(botPalette[color][mode]);
    expect(inSrgbGamut(body)).toBe(true);
    // Lighter than the bot, by enough to read as its small copy and not as the bot itself.
    expect(contrastRatio(body, bot)).toBeGreaterThanOrEqual(1.25);
    expect(contrastRatio(body, parseColor("#000000"))).toBeGreaterThan(
      contrastRatio(bot, parseColor("#000000")),
    );
  });

  it("one that failed keeps its silhouette: its rim reaches 3:1 against the canvases", () => {
    for (const role of canvases) {
      expect(
        contrastRatio(parseColor(littleFailed.rim[mode]), parseColor(colors[role][mode])),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("one that failed shows its shut eye: the eye's white reaches 3:1 on its body", () => {
    expect(
      contrastRatio(parseColor(avatarEye.lens), parseColor(littleFailed.body[mode])),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("a new row's light", () => {
  it("is the bot's own color on a light canvas", () => {
    const tone = rowLightColors(botPalette.cobalt.light, "light");
    expect(new Set([tone.spot, tone.lamp, tone.beam]).size).toBe(1);
  });

  it("is a warm white on a dark canvas, its beam taking some of the bot's color", () => {
    const tone = rowLightColors(botPalette.cobalt.dark, "dark");
    const away = (a: string, b: string) =>
      perceivedDistance(parseColor(a), parseColor(b), "typical");
    expect(away(tone.beam, tone.lamp)).toBeGreaterThan(0);
    expect(away(tone.beam, tone.lamp)).toBeLessThan(away(tone.beam, tone.spot));
  });
});

describe("the avatar's eye", () => {
  it("keeps its pupil at 4.5:1 against its lens", () => {
    expect(
      contrastRatio(parseColor(avatarEye.pupil), parseColor(avatarEye.lens)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(modes)("%s bot bubbles", (mode) => {
  const text = parseColor(colors["bubble-bot-foreground"][mode]);
  const code = parseColor(colors["code-background"][mode]);

  it.each(botColors)("keep text and code readable in a %s bot's bubble", (color) => {
    const bubble = parseColor(botBubble(color)[mode]);
    expect(inSrgbGamut(bubble)).toBe(true);
    expect(contrastRatio(text, bubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text, over(code, bubble))).toBeGreaterThanOrEqual(4.5);
  });
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

describe("mixOklab", () => {
  it("brings a mix sRGB cannot show into it, at the same lightness and hue", () => {
    // Half red, half white, as OKLab mixes them: lightness 0.814, chroma 0.129, hue 29.2, past sRGB's red.
    const mixed = mixOklab("#ff0000", "#ffffff", 0.5);
    const [, l, c, h] = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(mixed) ?? [];
    expect(Number(l)).toBeCloseTo(0.814, 3);
    expect(Number(h)).toBeCloseTo(29.2, 1);
    expect(Number(c)).toBeLessThan(0.128);
    expect(inSrgbGamut(parseColor(mixed))).toBe(true);
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

describe.each<[TypeInput, number]>([
  ["touch", 13],
  ["pointer", 12],
])("the %s type scale", (input, floor) => {
  const steps = Object.entries(typeScale).map(([name, step]) => ({ name, ...step[input] }));
  // The steps below `xl` set text that is read; from `xl` up they are headings.
  const text = steps.slice(
    0,
    steps.findIndex(({ name }) => name === "xl"),
  );

  it(`sets nothing smaller than ${floor}`, () => {
    for (const { size } of steps) expect(size).toBeGreaterThanOrEqual(floor);
  });

  it("never shrinks from one step to the next", () => {
    for (const [i, { size, lineHeight }] of steps.entries()) {
      const next = steps[i + 1];
      if (next === undefined) continue;
      expect(next.size).toBeGreaterThanOrEqual(size);
      expect(next.lineHeight).toBeGreaterThanOrEqual(lineHeight);
    }
  });

  it("gives text lines room for its ascenders and descenders", () => {
    for (const { size, lineHeight } of text) expect(lineHeight).toBeGreaterThanOrEqual(size * 1.25);
  });
});

describe("the type scale on touch", () => {
  it("is never smaller than on a pointer screen", () => {
    for (const step of Object.values(typeScale)) {
      expect(step.touch.size).toBeGreaterThanOrEqual(step.pointer.size);
    }
  });
});

describe("a bot's pointer glide", () => {
  it("takes the shortest glide for no move and the whole one across half the page or more", () => {
    expect(glideFor(0)).toBe(motion.glideShortest);
    expect(glideFor(0.5)).toBe(motion.glide);
    expect(glideFor(1)).toBe(motion.glide);
  });

  it("takes longer the longer the move", () => {
    const shares = [0.01, 0.05, 0.1, 0.2, 0.35, 0.5];
    const glides = shares.map(glideFor);
    expect(glides).toEqual([...glides].sort((a, b) => a - b));
    expect(new Set(glides).size).toBe(glides.length);
  });
});
