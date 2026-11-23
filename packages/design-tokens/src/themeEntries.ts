// SPDX-License-Identifier: AGPL-3.0-or-later
// The custom properties both generated stylesheets declare, named once so the
// web and the mobile theme cannot drift apart.
import { botBubble, botPalette } from "./botPalette.ts";
import { botColors } from "./names.ts";
import { colors, radii, typeScale, type Themed } from "./tokens.ts";

export type Entry = readonly [name: string, value: string];

export const declarations = (entries: ReadonlyArray<Entry>, indent: string) =>
  entries.map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

/** Each color role, bot color and bot bubble in `mode`, with names prefixed by `prefix`. */
export const colorEntries = (mode: keyof Themed, prefix: string): ReadonlyArray<Entry> => [
  ...Object.entries(colors).map(([role, value]): Entry => [`${prefix}${role}`, value[mode]]),
  ...Object.entries(botPalette).map(([color, value]): Entry => [
    `${prefix}bot-${color}`,
    value[mode],
  ]),
  ...botColors.map((color): Entry => [`${prefix}bot-bubble-${color}`, botBubble(color)[mode]]),
];

/** The type scale's sizes and line heights, as Tailwind's `--text-*` names them. */
export const typeEntries = (length: (px: number) => string): ReadonlyArray<Entry> =>
  Object.entries(typeScale).flatMap(([name, { size, lineHeight }]): ReadonlyArray<Entry> => [
    [`text-${name}`, length(size)],
    [`text-${name}--line-height`, length(lineHeight)],
  ]);

/** The radii; the pill radius stays 9999px, a length meant only to exceed any box. */
export const radiusEntries = (length: (px: number) => string): ReadonlyArray<Entry> =>
  Object.entries(radii).map(([name, px]): Entry => [
    `radius-${name}`,
    px >= 9999 ? "9999px" : length(px),
  ]);
