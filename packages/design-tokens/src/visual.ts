// SPDX-License-Identifier: AGPL-3.0-or-later
import { botPalette } from "./botPalette.ts";
import { hexColor, over, parseColor } from "./color.ts";
import { colors, type Themed } from "./tokens.ts";

/**
 * The colors a visual's page is given, as CSS variables on its `:root`
 * (`--background`, `--chart-1`…), each read through `pick`. The page sits on
 * `surface`, as a card does. The chart colors are six of the bot palette that
 * stay apart from each other. docs/design/design-language.md, "Visuals".
 */
const visualRoles = (pick: (value: Themed) => string) => ({
  background: pick(colors.surface),
  foreground: pick(colors.foreground),
  muted: pick(colors.muted),
  "muted-foreground": pick(colors["muted-foreground"]),
  border: pick(colors.border),
  accent: pick(colors.accent),
  "accent-foreground": pick(colors["accent-foreground"]),
  success: pick(colors.success),
  warning: pick(colors.waiting),
  destructive: pick(colors.blocked),
  "chart-1": pick(botPalette.cobalt),
  "chart-2": pick(botPalette.tangerine),
  "chart-3": pick(botPalette.mint),
  "chart-4": pick(botPalette.orchid),
  "chart-5": pick(botPalette.honey),
  "chart-6": pick(botPalette.sky),
});

export type VisualColor = keyof ReturnType<typeof visualRoles>;

/**
 * Every visual color in one theme, as opaque `#rrggbb`: a translucent token is
 * laid over the page's background first, so a chart library that reads a
 * color as hex, or mixes its own alpha into it, gets the color it shows.
 */
export const visualColors = (theme: keyof Themed): Readonly<Record<VisualColor, string>> => {
  const background = parseColor(colors.surface[theme]);
  return visualRoles((value) => hexColor(over(parseColor(value[theme]), background)));
};
