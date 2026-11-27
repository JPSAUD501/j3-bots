// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The art of the app's icons, the tray's and the favicon's: the brand mark,
 * "j3" as a lettermark in one weight, where the dot of the j is the status
 * light a bot carries on its antenna. Every platform's icon is drawn from it
 * (`raster/appIcon.ts`), so the icon changes here and nowhere else.
 */
import { botPalette } from "./botPalette.ts";
import { colors, type Themed } from "./tokens.ts";

/**
 * One drawing of the mark. A small icon is not the large one shrunk: its
 * strokes are heavier, its letters fill more of the plate, and it gives up
 * what a few px cannot show.
 */
export interface MarkDrawing {
  /** The smallest icon it is for, by its side in px. It serves up to the next drawing's. */
  readonly from: number;
  /** How wide the letters' strokes are, in the letters' units. */
  readonly weight: number;
  /** The letters' scale on the plate, whose side is 100 of the plate's units. */
  readonly fit: number;
  /** How far below the plate's middle the letters' own middle sits, in the plate's units. */
  readonly drop: number;
  /** The light's radius, in the letters' units. */
  readonly light: number;
  /** The light a step brighter, so that at a few px it stays a dot of color and not a gray one. */
  readonly bright: boolean;
  /** The glow around the light. */
  readonly glow: boolean;
  /** The plate shaded from top to bottom, or in one color. */
  readonly plate: "shaded" | "flat";
}

export interface IconArt {
  /**
   * The letters, each as SVG path data in units of their own, drawn as
   * outlines of a drawing's weight with round caps and joins, never filled.
   */
  readonly letters: ReadonlyArray<string>;
  /** The point of the letters' units that stands on the plate's middle. */
  readonly middle: { readonly x: number; readonly y: number };
  /** The letters' color: a theme's foreground, and on the plate the dark one's. */
  readonly ink: Themed;
  /** The dot of the j: where it is, its color, and the brighter one a small drawing takes. */
  readonly light: {
    readonly x: number;
    readonly y: number;
    readonly color: Themed;
    readonly bright: Themed;
  };
  /**
   * The glow around the light: the light's color, `opacity` of it at the
   * light's center and none `radius` away, in the letters' units. It shows on
   * a dark ground only, which is where a light glows.
   */
  readonly glow: { readonly radius: number; readonly opacity: number };
  /**
   * The plate under the mark, each color as `#rrggbb`, the same in every
   * theme, as an icon is: shaded from `top` to `bottom`, or `flat`.
   */
  readonly plate: { readonly top: string; readonly bottom: string; readonly flat: string };
  /** The drawings, from the smallest to the largest. The first serves every smaller icon too. */
  readonly drawings: readonly [MarkDrawing, ...ReadonlyArray<MarkDrawing>];
}

/**
 * The brand mark. The j is a stem with a hook, and its dot a light standing
 * clear above it, as a bot's stands on its antenna. The 3 is two open bowls,
 * the lower a little wider. The plate is the chrome's near-black, and the
 * only color is the light's, the iris of the bot palette.
 */
export const iconArt: IconArt = {
  letters: [
    "M35 42L35 66.5A11.5 11.5 0 0 1 23.5 78L21 78",
    "M52.17 32.25A12.5 12.5 0 1 1 63 51A13.5 13.5 0 1 1 51.31 71.25",
  ],
  middle: { x: 48.5, y: 51.4 },
  ink: colors.foreground,
  light: {
    x: 35,
    y: 26,
    color: botPalette.iris,
    // On a light ground a brighter light would only be a paler one.
    bright: { light: botPalette.iris.light, dark: "oklch(0.7 0.19 291)" },
  },
  glow: { radius: 24, opacity: 0.5 },
  plate: { top: "#232329", bottom: "#0a0a0c", flat: "#131316" },
  drawings: [
    {
      from: 16,
      weight: 14.5,
      fit: 1,
      drop: 0.6,
      light: 9.6,
      bright: true,
      glow: false,
      plate: "flat",
    },
    {
      from: 24,
      weight: 13,
      fit: 0.97,
      drop: 0.5,
      light: 8.6,
      bright: true,
      glow: false,
      plate: "flat",
    },
    {
      from: 32,
      weight: 12,
      fit: 0.94,
      drop: 0,
      light: 8,
      bright: true,
      glow: false,
      plate: "flat",
    },
    {
      from: 48,
      weight: 11,
      fit: 0.9,
      drop: 0,
      light: 7.2,
      bright: false,
      glow: false,
      plate: "shaded",
    },
    {
      from: 64,
      weight: 10.5,
      fit: 0.86,
      drop: 0,
      light: 7.2,
      bright: false,
      glow: true,
      plate: "shaded",
    },
  ],
};
