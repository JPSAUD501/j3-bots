// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  botPalette,
  colors,
  layout,
  radii,
  spacingUnit,
  typeScale,
  type Themed,
} from "./tokens.ts";

const px = (value: number) => `${value}px`;

const lines = (entries: ReadonlyArray<readonly [string, string]>, indent: string) =>
  entries.map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

const colorNames = [
  ...Object.keys(colors).map((role) => `color-${role}`),
  ...Object.keys(botPalette).map((color) => `color-bot-${color}`),
];

function themeVariables(mode: keyof Themed) {
  return [
    ...Object.entries(colors).map(([role, value]) => [`color-${role}`, value[mode]] as const),
    ...Object.entries(botPalette).map(
      ([color, value]) => [`color-bot-${color}`, value[mode]] as const,
    ),
  ];
}

/**
 * The mobile app's theme for Uniwind (Tailwind v4 for React Native): each
 * theme's colors in a `@variant light` and a `@variant dark` block of the
 * theme layer, which Uniwind switches with the system or a stored choice, and
 * the type scale, radii, spacing and touch sizes.
 *
 * Utilities are named as on the web (`bg-background`, `text-sm`,
 * `rounded-bubble`), with the same values. Lengths are in px: React Native has
 * no root font size, and Uniwind only multiplies rem by a configurable base.
 * Colors stay in the tokens' notation; Uniwind converts them to sRGB at build
 * time.
 *
 * Tailwind's default palette, type scale and radii are removed, as on the web.
 * Removing the palette also drops the names Uniwind registers for the theme's
 * variables, so the color names are registered again after it, the way Uniwind
 * does, and the file works wherever it is imported relative to Uniwind's own.
 *
 * Written for Uniwind 1.13.2 and Tailwind 4.3.3.
 */
export function renderUniwindCss(): string {
  const typeEntries = Object.entries(typeScale).flatMap(([name, { size, lineHeight }]) => [
    [`text-${name}`, px(size)] as const,
    [`text-${name}--line-height`, px(lineHeight)] as const,
  ]);
  const radiusEntries = Object.entries(radii).map(
    ([name, value]) => [`radius-${name}`, px(value)] as const,
  );

  return `/* Generated from packages/design-tokens/src by \`pnpm --filter @j3-bots/design-tokens generate\`. Do not edit. */

@layer theme {
  :root {
    @variant light {
${lines(themeVariables("light"), "      ")}
    }

    @variant dark {
${lines(themeVariables("dark"), "      ")}
    }
  }
}

@theme {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
${lines(
  [
    ...colorNames.map((name) => [name, "unset"] as const),
    ["spacing", px(spacingUnit)],
    ...typeEntries,
    ...radiusEntries,
  ],
  "  ",
)}
}

@theme static {
${lines(
  [
    ["layout-touch-target", px(layout.touchTarget)],
    ["layout-row-touch", px(layout.rowHeight.touch)],
  ],
  "  ",
)}
}
`;
}
