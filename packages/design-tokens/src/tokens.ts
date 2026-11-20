// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * J3 Bots' design tokens: the single source for every client's colors, type,
 * space, shape, motion and layout. The web stylesheet is generated from this
 * file (see `web.ts`); the mobile theme will be generated from it too.
 *
 * Colors are `#rrggbb` or `oklch(L C H)`, optionally with `/ alpha`. The
 * reasoning behind the values is in docs/design/design-language.md.
 */

export interface Themed {
  readonly light: string;
  readonly dark: string;
}

const themed = (light: string, dark: string): Themed => ({ light, dark });

/** Interface colors. Neutrals carry the interface; color marks focus and state. */
export const colors = {
  background: themed("#fcfcfc", "#000000"),
  /** Cards, popovers, the composer. */
  surface: themed("#ffffff", "#0e0e0f"),
  sidebar: themed("#f5f5f5", "#070707"),
  /** Hover and selection fill on rows and quiet controls. */
  muted: themed("#ebebed", "#18181a"),
  border: themed("#e4e4e7", "oklch(1 0 0 / 0.09)"),
  /** Borders of inputs and outline controls, a step stronger than `border`. */
  input: themed("#d4d4d8", "oklch(1 0 0 / 0.14)"),
  foreground: themed("#18181b", "#f4f4f5"),
  "muted-foreground": themed("#67676f", "#a1a1aa"),
  "bubble-operator": themed("#18181b", "#f4f4f5"),
  "bubble-operator-foreground": themed("#fafafa", "#09090b"),
  "bubble-bot": themed("#f0f0f2", "#18181b"),
  "bubble-bot-foreground": themed("#18181b", "#f4f4f5"),
  /** Inline code and code blocks, laid over whatever they sit on. */
  "code-background": themed("oklch(0 0 0 / 0.06)", "oklch(1 0 0 / 0.08)"),
  /** Focus and links. */
  accent: themed("oklch(0.49 0.22 264)", "oklch(0.72 0.15 264)"),
  "accent-foreground": themed("#ffffff", "#09090b"),
  /** A bot needs the operator: a question or an approval. */
  waiting: themed("oklch(0.52 0.12 65)", "oklch(0.82 0.15 80)"),
  "waiting-surface": themed("oklch(0.975 0.03 85)", "oklch(0.21 0.045 70)"),
  /** A turn cannot continue, and destructive actions. */
  blocked: themed("oklch(0.53 0.2 27)", "oklch(0.71 0.17 25)"),
  "blocked-surface": themed("oklch(0.975 0.015 20)", "oklch(0.2 0.05 25)"),
  success: themed("oklch(0.52 0.12 160)", "oklch(0.78 0.14 160)"),
  /** Marks drawn inside an avatar, over the bot's color. */
  "avatar-ink": themed("#ffffff", "#0b0b0c"),
  /** Behind sheets and dialogs. */
  scrim: themed("oklch(0 0 0 / 0.32)", "oklch(0 0 0 / 0.6)"),
} as const satisfies Record<string, Themed>;

export type ColorRole = keyof typeof colors;

/**
 * The bot palette. Every value reaches 3:1 against the canvases and against
 * `avatar-ink`. Lightness varies on purpose: every pair stays apart for typical
 * vision and for simulated protanopia, deuteranopia and tritanopia.
 */
export const botPalette = {
  red: themed("oklch(0.441 0.179 29)", "oklch(0.555 0.193 33)"),
  orange: themed("oklch(0.537 0.095 66)", "oklch(0.682 0.132 57)"),
  yellow: themed("oklch(0.618 0.127 97)", "oklch(0.79 0.162 94)"),
  green: themed("oklch(0.401 0.091 159)", "oklch(0.812 0.104 149)"),
  teal: themed("oklch(0.61 0.102 206)", "oklch(0.708 0.093 189)"),
  blue: themed("oklch(0.516 0.124 243)", "oklch(0.596 0.217 271)"),
  indigo: themed("oklch(0.322 0.193 281)", "oklch(0.72 0.151 295)"),
  violet: themed("oklch(0.622 0.183 295)", "oklch(0.523 0.148 298)"),
  pink: themed("oklch(0.451 0.136 336)", "oklch(0.584 0.094 349)"),
  gray: themed("oklch(0.532 0 0)", "oklch(0.93 0 0)"),
} as const satisfies Record<string, Themed>;

export type BotColor = keyof typeof botPalette;

export const botColors = Object.keys(botPalette) as ReadonlyArray<BotColor>;

export const fonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Inter Variable", sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
} as const;

/** Size and line height in px. Message text is `base` on pointer devices and `lg` on phones. */
export const typeScale = {
  "2xs": { size: 11, lineHeight: 16 },
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 18 },
  base: { size: 14, lineHeight: 20 },
  lg: { size: 16, lineHeight: 24 },
  xl: { size: 20, lineHeight: 28 },
} as const;

export const fontWeights = { regular: 400, medium: 500, semibold: 600 } as const;

/** Every spacing value is a multiple of this, in px. */
export const spacingUnit = 4;

/** Corner radii in px. */
export const radii = {
  /** Badges, the tightened corner of a bubble. */
  sm: 4,
  /** Controls and cards. */
  md: 8,
  /** Popovers, sheets, dialogs. */
  lg: 12,
  bubble: 16,
  pill: 9999,
} as const;

/** Durations in ms. */
export const motion = {
  /** Hover and press feedback. */
  fast: 120,
  /** A change of state, played once. */
  state: 160,
  /** Larger moves: a sheet, a fold opening. */
  slow: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  /**
   * Avatar motion is stepped: the mark changes position a few times per
   * second instead of every frame, so a roster full of busy bots does not keep
   * the display refreshing at full rate.
   */
  avatar: {
    breathePeriod: 2400,
    breatheSteps: 12,
    spinPeriod: 1600,
    spinSteps: 8,
  },
} as const;

/** In px. */
export const layout = {
  rosterWidth: 280,
  detailsWidth: 320,
  /** Maximum width of the conversation's text column. */
  textColumn: 720,
  rowHeight: { pointer: 52, touch: 64 },
  /** Minimum touch target. */
  touchTarget: 44,
  /** Below `tablet` one region shows at a time; from `wide` the details pane sits beside the conversation. */
  breakpoints: { tablet: 768, wide: 1200 },
} as const;
