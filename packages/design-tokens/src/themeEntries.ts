// SPDX-License-Identifier: AGPL-3.0-or-later
// The custom properties both generated stylesheets declare, named once so the
// web and the mobile theme cannot drift apart.
import { botBubble, botLittle, botPalette, botTrackLit, littleFailed } from "./botPalette.ts";
import { botColors } from "./names.ts";
import { colors, radii, typeScale, type Themed, type TypeInput } from "./tokens.ts";

export type Entry = readonly [name: string, value: string];

export const declarations = (entries: ReadonlyArray<Entry>, indent: string) =>
  entries.map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

/** Each color role, bot color, bot bubble, little one's color and lit track row in `mode`, with names prefixed by `prefix`. */
export const colorEntries = (mode: keyof Themed, prefix: string): ReadonlyArray<Entry> => [
  ...Object.entries(colors).map(([role, value]): Entry => [`${prefix}${role}`, value[mode]]),
  ...Object.entries(botPalette).map(([color, value]): Entry => [
    `${prefix}bot-${color}`,
    value[mode],
  ]),
  ...botColors.map((color): Entry => [`${prefix}bot-bubble-${color}`, botBubble(color)[mode]]),
  ...botColors.map((color): Entry => [`${prefix}bot-little-${color}`, botLittle(color)[mode]]),
  ...botColors.map((color): Entry => [`${prefix}bot-lit-${color}`, botTrackLit(color)[mode]]),
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
