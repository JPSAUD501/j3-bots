// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The bot palette: the twelve colors a bot's body takes, and the colors of
 * its eye. docs/design/design-language.md, "Bot palette", gives the reasoning.
 *
 * Every body color reaches 3:1 against each canvas of its theme (background,
 * surface, sidebar and muted), so a silhouette always reads as a shape, and
 * against `avatar-ink`, what the interface draws over a bot's color. Light
 * values sit darker than the dark ones for that reason. Hues are spread so
 * every pair stays apart for typical vision; under simulated color vision
 * deficiency some pairs come close, which the silhouette covers: no two of
 * the first twelve bots the server names share a shape (`avatarCast`).
 */
import { hexColor, mixOklab, parseColor, washedOut } from "./color.ts";
import type { BotColor } from "./names.ts";
import { colors, type Themed } from "./tokens.ts";

const themed = (light: string, dark: string): Themed => ({ light, dark });

export const botPalette = {
  tomato: themed("oklch(0.615 0.2 24)", "oklch(0.665 0.21 28)"),
  tangerine: themed("oklch(0.635 0.162 50)", "oklch(0.745 0.172 52)"),
  honey: themed("oklch(0.62 0.126 84)", "oklch(0.825 0.16 86)"),
  lime: themed("oklch(0.61 0.147 122)", "oklch(0.795 0.19 128)"),
  mint: themed("oklch(0.605 0.13 160)", "oklch(0.755 0.15 162)"),
  teal: themed("oklch(0.56 0.094 199)", "oklch(0.685 0.116 200)"),
  sky: themed("oklch(0.615 0.131 236)", "oklch(0.725 0.14 236)"),
  cobalt: themed("oklch(0.52 0.21 264)", "oklch(0.575 0.21 262)"),
  iris: themed("oklch(0.58 0.21 294)", "oklch(0.625 0.21 291)"),
  orchid: themed("oklch(0.645 0.21 320)", "oklch(0.685 0.21 326)"),
  rose: themed("oklch(0.645 0.19 354)", "oklch(0.705 0.19 357)"),
  slate: themed("oklch(0.5 0.03 262)", "oklch(0.595 0.035 262)"),
} as const satisfies Record<BotColor, Themed>;

/**
 * How strongly a bot's color tints its bubbles over the canvas: more in the
 * dark theme, where a light tint would vanish.
 */
export const botBubbleTint = { light: 0.11, dark: 0.28 } as const satisfies Record<
  keyof Themed,
  number
>;

/**
 * A bot's bubbles: a tint of its color over the canvas. Derived from
 * `botPalette`, so every color there has its bubble.
 */
export const botBubble = (color: BotColor): Themed => ({
  light: mixOklab(botPalette[color].light, colors.background.light, botBubbleTint.light),
  dark: mixOklab(botPalette[color].dark, colors.background.dark, botBubbleTint.dark),
});

/**
 * The eye, the same in both themes: a white lens and a near-black pupil,
 * which keep 18:1 between them on any body. The glint is the eye's white.
 */
export const avatarEye = {
  lens: "#ffffff",
  pupil: "#141418",
} as const;

/**
 * A bot's body color in `theme` as `#rrggbb`, for a renderer that takes no CSS
 * color: as it is, or nearly greyed out while the bot shows asleep.
 */
export const avatarBodyColor = (color: BotColor, theme: keyof Themed, asleep: boolean): string => {
  const value = botPalette[color][theme];
  return asleep ? hexColor(washedOut(parseColor(value))) : hexColor(value);
};
