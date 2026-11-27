// SPDX-License-Identifier: AGPL-3.0-or-later
// The custom properties both generated stylesheets declare, named once so the
// web and the mobile theme cannot drift apart.
import { botBubbleIn, botLittle, botPalette, botTrackLitIn, littleFailed } from "./botPalette.ts";
import { botColors } from "./names.ts";
import { type Palette, radii, typeScale, type Themed, type TypeInput } from "./tokens.ts";

export type Entry = readonly [name: string, value: string];

export const declarations = (entries: ReadonlyArray<Entry>, indent: string) =>
  entries.map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

/**
 * Each color role of `palette`, and each bot color, bot bubble, little one's
 * color and lit track row over it, in `mode`, with names prefixed by
 * `prefix`. The stock stylesheets take the stock palette; a theme is the same
 * entries over its own (theme.ts).
 */
export const colorEntries = (
  palette: Palette,
  mode: keyof Themed,
  prefix: string,
): ReadonlyArray<Entry> => [
  ...Object.entries(palette).map(([role, value]): Entry => [`${prefix}${role}`, value]),
  ...Object.entries(botPalette).map(([color, value]): Entry => [
    `${prefix}bot-${color}`,
    value[mode],
  ]),
  ...botColors.map((color): Entry => [
    `${prefix}bot-bubble-${color}`,
    botBubbleIn(color, palette, mode),
  ]),
  ...botColors.map((color): Entry => [`${prefix}bot-little-${color}`, botLittle(color)[mode]]),
  ...botColors.map((color): Entry => [
    `${prefix}bot-lit-${color}`,
    botTrackLitIn(color, palette, mode),
  ]),
  [`${prefix}little-failed`, littleFailed.body[mode]],
  [`${prefix}little-failed-rim`, littleFailed.rim[mode]],
];

/** The type scale's sizes and line heights for `input`, as Tailwind's `--text-*` names them. */
export const typeEntries = (
  input: TypeInput,
  length: (px: number) => string,
): ReadonlyArray<Entry> =>
  Object.entries(typeScale).flatMap(([name, step]): ReadonlyArray<Entry> => [
    [`text-${name}`, length(step[input].size)],
    [`text-${name}--line-height`, length(step[input].lineHeight)],
  ]);

/** The radii; the pill radius stays 9999px, a length meant only to exceed any box. */
export const radiusEntries = (length: (px: number) => string): ReadonlyArray<Entry> =>
  Object.entries(radii).map(([name, px]): Entry => [
    `radius-${name}`,
    px >= 9999 ? "9999px" : length(px),
  ]);
