// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  botPalette,
  colors,
  fonts,
  layout,
  motion,
  radii,
  spacingUnit,
  typeScale,
  type Themed,
} from "./tokens.ts";

const rem = (px: number) => `${px / 16}rem`;

const lines = (entries: ReadonlyArray<readonly [string, string]>, indent = "  ") =>
  entries.map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

function themeVariables(mode: keyof Themed) {
  return [
    ...Object.entries(colors).map(([role, value]) => [role, value[mode]] as const),
    ...Object.entries(botPalette).map(([color, value]) => [`bot-${color}`, value[mode]] as const),
  ];
}

/**
 * The web stylesheet for the tokens: each theme's values as custom properties
 * (on `:root` and `.light`, and on `.dark`), and a Tailwind v4 theme that maps
 * utilities onto them. Tailwind's default palette and type scale are removed,
 * so only J3 Bots' tokens can be used.
 *
 * Either theme class can be set on any element to render its subtree in that
 * theme.
 */
export function renderWebCss(): string {
  const colorUtilities = [
    ...Object.keys(colors).map((role) => [`color-${role}`, `var(--${role})`] as const),
    ...Object.keys(botPalette).map((c) => [`color-bot-${c}`, `var(--bot-${c})`] as const),
  ];
  const typeEntries = Object.entries(typeScale).flatMap(([name, { size, lineHeight }]) => [
    [`text-${name}`, rem(size)] as const,
    [`text-${name}--line-height`, rem(lineHeight)] as const,
  ]);
  const radiusEntries = Object.entries(radii).map(
    ([name, px]) => [`radius-${name}`, px >= 9999 ? "9999px" : rem(px)] as const,
  );

  return `/* Generated from packages/design-tokens/src by \`pnpm --filter @j3-bots/design-tokens generate\`. Do not edit. */

:root,
.light {
  color-scheme: light;
${lines(themeVariables("light"))}
}

.dark {
  color-scheme: dark;
${lines(themeVariables("dark"))}
}

:root {
${lines([
  ["duration-fast", `${motion.fast}ms`],
  ["duration-state", `${motion.state}ms`],
  ["duration-slow", `${motion.slow}ms`],
  ["avatar-breathe-period", `${motion.avatar.breathePeriod}ms`],
  ["avatar-breathe-steps", String(motion.avatar.breatheSteps)],
  ["avatar-spin-period", `${motion.avatar.spinPeriod}ms`],
  ["avatar-spin-steps", String(motion.avatar.spinSteps)],
  ["layout-roster-width", rem(layout.rosterWidth)],
  ["layout-details-width", rem(layout.detailsWidth)],
  ["layout-text-column", rem(layout.textColumn)],
  ["layout-row-pointer", rem(layout.rowHeight.pointer)],
  ["layout-row-touch", rem(layout.rowHeight.touch)],
  ["layout-touch-target", rem(layout.touchTarget)],
  [
    "layout-bubble-width",
    `min(${rem(layout.entryWidth.max)}, ${layout.entryWidth.bubbleShare * 100}%)`,
  ],
  [
    "layout-card-width",
    `min(${rem(layout.entryWidth.max)}, ${layout.entryWidth.cardShare * 100}%)`,
  ],
  [
    "layout-compact-card-width",
    `min(${rem(layout.compactCardWidth)}, ${layout.entryWidth.cardShare * 100}%)`,
  ],
  ["layout-composer-max-height", rem(layout.composerMaxHeight)],
])}
}

@theme {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
${lines([
  ["font-sans", fonts.sans],
  ["font-mono", fonts.mono],
  ["spacing", rem(spacingUnit)],
  ["ease-standard", motion.easing],
  ["breakpoint-tablet", rem(layout.breakpoints.tablet)],
  ["breakpoint-wide", rem(layout.breakpoints.wide)],
  // The app shell lays out by its own width, so a frame can show any layout.
  ["container-tablet", rem(layout.breakpoints.tablet)],
  ["container-wide", rem(layout.breakpoints.wide)],
  ...typeEntries,
  ...radiusEntries,
])}
}

@theme inline {
${lines(colorUtilities)}
}
`;
}
