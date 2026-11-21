// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  colorEntries,
  declarations,
  radiusEntries,
  typeEntries,
  type Entry,
} from "./themeEntries.ts";
import { layout, spacingUnit } from "./tokens.ts";

const px = (value: number) => `${value}px`;

/**
 * The mobile app's theme for Uniwind (Tailwind v4 for React Native): each
 * theme's colors in a `@variant light` and a `@variant dark` block of the
 * theme layer, which Uniwind switches with the system or a stored choice, and
 * the type scale, radii, spacing, breakpoints and touch sizes.
 *
 * Utilities are named as on the web (`bg-background`, `text-sm`,
 * `rounded-bubble`), with the same values. Lengths are in px: React Native has
 * no root font size, and Uniwind only multiplies rem by a configurable base.
 * Colors stay in the tokens' notation; Uniwind converts them to 8-bit sRGB at
 * build time, so a color outside sRGB renders clipped where the web shows it
 * whole.
 *
 * Tailwind's default palette, type scale, radii and font families are removed.
 * The fonts are left to the app: React Native takes one family name, which
 * differs by platform.
 * Removing the palette also drops the names Uniwind registers for the theme's
 * variables, so the color names are registered again after it, the way Uniwind
 * does, and the file works wherever it is imported relative to Uniwind's own.
 *
 * The resets only hold when this file is imported after `tailwindcss` and
 * `uniwind`. Written for Uniwind 1.13.2 and Tailwind 4.3.3.
 */
export function renderUniwindCss(): string {
  const light = colorEntries("light", "color-");
  const dark = colorEntries("dark", "color-");

  return `/* Generated from packages/design-tokens/src by \`pnpm --filter @j3-bots/design-tokens generate\`. Do not edit. */

@layer theme {
  :root {
    @variant light {
${declarations(light, "      ")}
    }

    @variant dark {
${declarations(dark, "      ")}
    }
  }
}

@theme {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --font-*: initial;
${declarations(
  [
    ...light.map(([name]): Entry => [name, "unset"]),
    ["spacing", px(spacingUnit)],
    ["breakpoint-tablet", px(layout.breakpoints.tablet)],
    ["breakpoint-wide", px(layout.breakpoints.wide)],
    ...typeEntries(px),
    ...radiusEntries(px),
  ],
  "  ",
)}
}

@theme static {
${declarations(
  [
    ["layout-touch-target", px(layout.touchTarget)],
    ["layout-row-touch", px(layout.rowHeight.touch)],
  ],
  "  ",
)}
}
`;
}
