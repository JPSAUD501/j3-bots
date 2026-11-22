// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  colorEntries,
  declarations,
  radiusEntries,
  typeEntries,
  type Entry,
} from "./themeEntries.ts";
import { eases, press, springs } from "./springs.ts";
import {
  displayTracking,
  fontFaces,
  fonts,
  layout,
  motion,
  shadows,
  spacingUnit,
} from "./tokens.ts";

const rem = (px: number) => `${px / 16}rem`;

const lines = (entries: ReadonlyArray<Entry>) => declarations(entries, "  ");

/** The bundled faces, from the package's `fonts/`, shown in the fallback until they load. */
const fontFaceRules = () =>
  fontFaces
    .map(
      ({ family, weight, file }) => `@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url("../fonts/${file}.woff2") format("woff2");
}`,
    )
    .join("\n\n");

const shadowEntries = (mode: "light" | "dark"): ReadonlyArray<Entry> =>
  Object.entries(shadows).map(([name, value]): Entry => [`elevation-${name}`, value[mode]]);

/** Each spring's easing and duration: `ease-pop` with `duration-(--duration-pop)`. */
const springEntries = (): ReadonlyArray<Entry> =>
  Object.entries(springs).map(([name, spring]): Entry => [
    `duration-${name}`,
    `${spring.duration}ms`,
  ]);

/**
 * The web stylesheet for the tokens: each theme's values as custom properties
 * (on `:root` and `.light`, and on `.dark`), and a Tailwind v4 theme that maps
 * utilities onto them. Tailwind's default palette and type scale are removed,
 * so only J3 Bots' tokens can be used.
 *
 * Either theme class can be set on any element to render its subtree in that
 * theme. The bundled faces are declared here, so whatever imports the sheet
 * loads them from the package with nothing from a font service. Each spring is
 * an easing utility (`ease-pop`) with its duration as a variable
 * (`--duration-pop`), since a spring's easing only holds over its own length.
 */
export function renderWebCss(): string {
  const colorUtilities = colorEntries("light", "").map(([name]): Entry => [
    `color-${name}`,
    `var(--${name})`,
  ]);

  return `/* Generated from packages/design-tokens/src by \`pnpm --filter @j3-bots/design-tokens generate\`. Do not edit. */

${fontFaceRules()}

:root,
.light {
  color-scheme: light;
${lines([...colorEntries("light", ""), ...shadowEntries("light")])}
}

.dark {
  color-scheme: dark;
${lines([...colorEntries("dark", ""), ...shadowEntries("dark")])}
}

:root {
${lines([
  ["duration-fast", `${motion.fast}ms`],
  ["duration-state", `${motion.state}ms`],
  ["duration-slow", `${motion.slow}ms`],
  ...springEntries(),
  ["duration-press", `${press.duration}ms`],
  ["press-scale", String(press.scale)],
  ["press-scale-round", String(press.roundScale)],
  ["press-scale-row", String(press.rowScale)],
  ["display-tracking", `${displayTracking}em`],
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
  --shadow-*: initial;
${lines([
  ["font-sans", fonts.sans],
  ["font-display", fonts.display],
  ["font-mono", fonts.mono],
  ["spacing", rem(spacingUnit)],
  ["ease-out", eases.out],
  ...Object.entries(springs).map(([name, spring]): Entry => [`ease-${name}`, spring.easing]),
  ["breakpoint-tablet", rem(layout.breakpoints.tablet)],
  ["breakpoint-wide", rem(layout.breakpoints.wide)],
  // The app shell lays out by its own width, so a frame can show any layout.
  ["container-tablet", rem(layout.breakpoints.tablet)],
  ["container-wide", rem(layout.breakpoints.wide)],
  ...typeEntries(rem),
  ...radiusEntries(rem),
])}
}

@theme inline {
${lines([
  ...colorUtilities,
  ...Object.keys(shadows).map((name): Entry => [`shadow-${name}`, `var(--elevation-${name})`]),
])}
}
`;
}
