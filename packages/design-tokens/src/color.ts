// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Color math for checking the tokens: parsing the two notations the tokens use,
 * WCAG contrast, and simulated color vision deficiency. Formulas: OKLab (Björn
 * Ottosson, 2020), WCAG 2.2 relative luminance, and Machado, Oliveira and
 * Fernandes (2009) at full severity.
 */

/** Linear-light sRGB, each channel 0 to 1, plus alpha. */
export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const HEX = /^#([0-9a-f]{6})$/i;
const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i;

/** Parses `#rrggbb` or `oklch(L C H)` / `oklch(L C H / A)`. Throws on anything else. */
export function parseColor(value: string): LinearRgb {
  const hex = HEX.exec(value);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return {
      r: toLinear(((n >> 16) & 255) / 255),
      g: toLinear(((n >> 8) & 255) / 255),
      b: toLinear((n & 255) / 255),
      alpha: 1,
    };
  }
  const lch = OKLCH.exec(value);
  if (lch?.[1] !== undefined && lch[2] !== undefined && lch[3] !== undefined) {
    const l = Number(lch[1]);
    const c = Number(lch[2]);
    const h = (Number(lch[3]) * Math.PI) / 180;
    const alpha = lch[4] === undefined ? 1 : Number(lch[4]) / (lch[5] === "%" ? 100 : 1);
    return { ...oklabToLinear({ l, a: c * Math.cos(h), b: c * Math.sin(h) }), alpha };
  }
  throw new Error(`Unsupported color notation: ${value}`);
}

function oklabToLinear({ l, a, b }: Lab): Omit<LinearRgb, "alpha"> {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    g: -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    b: -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  };
}

function linearToOklab({ r, g, b }: Omit<LinearRgb, "alpha">): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Whether the color can be shown on an sRGB display without clipping. */
export function inSrgbGamut(color: LinearRgb): boolean {
  const epsilon = 1e-4;
  return [color.r, color.g, color.b].every((c) => c >= -epsilon && c <= 1 + epsilon);
}

const fromLinear = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** The color as 8-bit sRGB channels, for raster output. Out-of-gamut channels are clipped. */
export function toSrgb8(color: LinearRgb): readonly [number, number, number] {
  const channel = (c: number) => Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255);
  return [channel(color.r), channel(color.g), channel(color.b)];
}

/**
 * An opaque color as `#rrggbb` in 8-bit sRGB, for what takes no other form:
 * a native window's background, an app's splash screen. Alpha is dropped.
 */
export function hexColor(value: string): string {
  const hex = toSrgb8(parseColor(value)).map((c) => c.toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

/** Composites `top` over an opaque `bottom`. */
export function over(top: LinearRgb, bottom: LinearRgb): LinearRgb {
  const mix = (t: number, u: number) => t * top.alpha + u * (1 - top.alpha);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), alpha: 1 };
}

const clamp = (c: number) => Math.min(1, Math.max(0, c));

function luminance(color: LinearRgb): number {
  return 0.2126 * clamp(color.r) + 0.7152 * clamp(color.g) + 0.0722 * clamp(color.b);
}

/** WCAG contrast ratio between two opaque colors, from 1 to 21. */
export function contrastRatio(a: LinearRgb, b: LinearRgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type Vision = "typical" | "protanopia" | "deuteranopia" | "tritanopia";

// Machado et al. (2009), severity 1.0, applied to linear RGB.
const DEFICIENCY: Record<Exclude<Vision, "typical">, readonly number[]> = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
};

function simulate(color: LinearRgb, vision: Vision): LinearRgb {
  if (vision === "typical") return color;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = DEFICIENCY[vision];
  const { r, g: gr, b: bl } = { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b) };
  return {
    r: clamp(a * r + b * gr + c * bl),
    g: clamp(d * r + e * gr + f * bl),
    b: clamp(g * r + h * gr + i * bl),
    alpha: color.alpha,
  };
}

/** Perceptual distance (ΔE in OKLab) between two colors as a viewer with `vision` sees them. */
export function perceivedDistance(x: LinearRgb, y: LinearRgb, vision: Vision): number {
  const p = linearToOklab(simulate(x, vision));
  const q = linearToOklab(simulate(y, vision));
  return Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b);
}
