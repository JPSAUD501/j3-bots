// SPDX-License-Identifier: AGPL-3.0-or-later
import { botPalette } from "./botPalette.ts";
import { hexColor, over, parseColor } from "./color.ts";
import { colors, fonts, radii, shadows, type Themed, type TypeInput, typeScale } from "./tokens.ts";

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

/**
 * Every CSS variable a visual's page is given on its `:root`, without the
 * leading `--`: the colors of one theme, the app's sans and mono font stacks
 * (the stacks only: a visual has none of the app's font files) and the
 * corner radius. Clients set exactly these, and the bot is told their names.
 */
export const visualVariables = (theme: keyof Themed): Readonly<Record<string, string>> => ({
  ...visualColors(theme),
  "font-sans": fonts.sans,
  "font-mono": fonts.mono,
  radius: `${radii.md}px`,
});

/**
 * The style variables a connector's app is given in its host context
 * (`hostContext.styles.variables`), named as the MCP Apps extension names
 * them, for one theme and the type scale `input` reads at: the visual colors,
 * the app's font stacks (the stacks only: an app has none of the app's font
 * files), weights, sizes and line heights, corner radii, the border width and
 * the shadows. J3 Bots' chrome is monochrome, so `info` is its accent. Its
 * type scale has no heading past `4xl`, so the two largest headings are not
 * given: an app keeps its own for those, as for anything not given.
 */
export const appStyleVariables = (
  theme: keyof Themed,
  input: TypeInput,
): Readonly<Record<string, string>> => {
  const color = visualColors(theme);
  const px = (value: number) => `${value}px`;
  const type = (name: string, step: keyof typeof typeScale) => ({
    [`--font-${name}-size`]: px(typeScale[step][input].size),
    [`--font-${name}-line-height`]: px(typeScale[step][input].lineHeight),
  });
  return {
    "--color-background-primary": color.background,
    "--color-background-secondary": color.muted,
    "--color-background-tertiary": color.muted,
    "--color-background-inverse": color.accent,
    "--color-background-ghost": "transparent",
    "--color-background-info": color.accent,
    "--color-background-danger": color.destructive,
    "--color-background-success": color.success,
    "--color-background-warning": color.warning,
    "--color-background-disabled": color.muted,
    "--color-text-primary": color.foreground,
    "--color-text-secondary": color["muted-foreground"],
    "--color-text-tertiary": color["muted-foreground"],
    "--color-text-inverse": color["accent-foreground"],
    "--color-text-ghost": color["muted-foreground"],
    "--color-text-info": color.accent,
    "--color-text-danger": color.destructive,
    "--color-text-success": color.success,
    "--color-text-warning": color.warning,
    "--color-text-disabled": color["muted-foreground"],
    "--color-border-primary": color.border,
    "--color-border-secondary": color.border,
    "--color-border-tertiary": color.border,
    "--color-border-inverse": color["accent-foreground"],
    "--color-border-ghost": "transparent",
    "--color-border-info": color.accent,
    "--color-border-danger": color.destructive,
    "--color-border-success": color.success,
    "--color-border-warning": color.warning,
    "--color-border-disabled": color.border,
    "--color-ring-primary": color.accent,
    "--color-ring-secondary": color["muted-foreground"],
    "--color-ring-inverse": color["accent-foreground"],
    "--color-ring-info": color.accent,
    "--color-ring-danger": color.destructive,
    "--color-ring-success": color.success,
    "--color-ring-warning": color.warning,
    "--font-sans": fonts.sans,
    "--font-mono": fonts.mono,
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    ...type("text-xs", "xs"),
    ...type("text-sm", "sm"),
    ...type("text-md", "base"),
    ...type("text-lg", "lg"),
    ...type("heading-xs", "lg"),
    ...type("heading-sm", "xl"),
    ...type("heading-md", "2xl"),
    ...type("heading-lg", "3xl"),
    ...type("heading-xl", "4xl"),
    "--border-radius-xs": px(radii.sm),
    "--border-radius-sm": px(radii.sm),
    "--border-radius-md": px(radii.md),
    "--border-radius-lg": px(radii.lg),
    "--border-radius-xl": px(radii.xl),
    "--border-radius-full": px(radii.pill),
    "--border-width-regular": "1px",
    "--shadow-hairline": `0 0 0 1px ${color.border}`,
    "--shadow-sm": shadows.raised[theme],
    "--shadow-md": shadows.lift[theme],
    "--shadow-lg": shadows.overlay[theme],
  };
};
