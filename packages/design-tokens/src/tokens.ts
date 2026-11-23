// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * J3 Bots' design tokens: the single source for every client's colors, type,
 * space, shape, motion and layout. The web stylesheet (`web.ts`) and the
 * mobile app's Uniwind theme (`uniwind.ts`) are generated from this file.
 *
 * Colors are `#rrggbb` or `oklch(L C H)`, optionally with `/ alpha`. The
 * reasoning behind the values is in docs/design/design-language.md.
 */
import type { BotColor } from "./names.ts";

export interface Themed {
  readonly light: string;
  readonly dark: string;
}

const themed = (light: string, dark: string): Themed => ({ light, dark });

/**
 * Interface colors: near-monochrome chrome on a true-black dark canvas. Color
 * on screen belongs to the bots and to state; the focus ring, links and the
 * primary action are the text color.
 */
export const colors = {
  background: themed("#ffffff", "#000000"),
  /** Cards, popovers, dialogs, sheets, the composer. */
  surface: themed("#ffffff", "#101012"),
  sidebar: themed("#f6f6f7", "#09090a"),
  /** A quiet filled control, a field, and the hover and selection fill of a row. */
  muted: themed("#f0f0f2", "#19191c"),
  /** The hover fill of a control that is already `muted`. */
  "muted-strong": themed("#e5e5e9", "#242428"),
  border: themed("#e8e8ec", "oklch(1 0 0 / 0.09)"),
  /** Borders of outline controls and fields, a step stronger than `border`. */
  input: themed("#d4d4da", "oklch(1 0 0 / 0.15)"),
  foreground: themed("#101012", "#f5f5f6"),
  "muted-foreground": themed("#5f5f69", "#a3a3ad"),
  "bubble-operator": themed("#101012", "#2a2a30"),
  "bubble-operator-foreground": themed("#ffffff", "#f5f5f6"),
  "bubble-bot": themed("#f0f0f2", "#19191c"),
  "bubble-bot-foreground": themed("#101012", "#f5f5f6"),
  /** Inline code and code blocks, laid over whatever they sit on. */
  "code-background": themed("oklch(0 0 0 / 0.055)", "oklch(1 0 0 / 0.07)"),
  /** Focus rings, links, unread, the primary action: the text color, so the chrome stays monochrome. */
  accent: themed("#101012", "#f5f5f6"),
  "accent-foreground": themed("#ffffff", "#0a0a0b"),
  /** A bot needs the operator: a question or an approval. */
  waiting: themed("oklch(0.52 0.12 65)", "oklch(0.82 0.15 80)"),
  "waiting-surface": themed("oklch(0.975 0.03 85)", "oklch(0.21 0.045 70)"),
  /** A turn cannot continue, and destructive actions. */
  blocked: themed("oklch(0.53 0.2 27)", "oklch(0.71 0.17 25)"),
  "blocked-surface": themed("oklch(0.975 0.015 20)", "oklch(0.2 0.05 25)"),
  success: themed("oklch(0.52 0.12 160)", "oklch(0.78 0.14 160)"),
  /**
   * The track of a switch that is on. Darker than `success` in dark, where the
   * light thumb needs 3:1 against it.
   */
  "control-on": themed("oklch(0.52 0.12 160)", "oklch(0.6 0.13 160)"),
  /** The track of a switch that is off: a boundary of 3:1 against every canvas. */
  "control-off": themed("#82828a", "#6b6b73"),
  /**
   * The thumb of a switch the system draws, light in both themes. Android draws
   * it past the ends of the track, over the page, where `background` would hide it.
   */
  "control-thumb": themed("#ffffff", "#f5f5f6"),
  /** Marks drawn inside an avatar, over the bot's color. */
  "avatar-ink": themed("#ffffff", "#0b0b0c"),
  /** Behind sheets and dialogs. */
  scrim: themed("oklch(0 0 0 / 0.3)", "oklch(0 0 0 / 0.62)"),
} as const satisfies Record<string, Themed>;

/**
 * Elevation, for what lies over other content: popovers, dialogs, sheets. On
 * the black canvas a shadow cannot show, so the dark theme draws a faint
 * outline instead.
 */
export const shadows = {
  /** A card or a field that sits a little above the page. */
  raised: themed("0 1px 2px oklch(0 0 0 / 0.04)", "none"),
  /** Popovers, menus, dialogs and sheets. */
  overlay: themed(
    "0 12px 32px -8px oklch(0 0 0 / 0.18), 0 2px 6px oklch(0 0 0 / 0.06)",
    "0 12px 32px -8px oklch(0 0 0 / 0.8), 0 0 0 1px oklch(1 0 0 / 0.07)",
  ),
  /** A switch's thumb, lifted off its track. */
  thumb: themed(
    "0 1px 3px oklch(0 0 0 / 0.2), 0 0 0 0.5px oklch(0 0 0 / 0.06)",
    "0 1px 3px oklch(0 0 0 / 0.5)",
  ),
} as const satisfies Record<string, Themed>;

export type ColorRole = keyof typeof colors;

/**
 * The bot palette. Every value reaches 3:1 against the canvases and against
 * `avatar-ink`. Lightness varies on purpose: every pair stays apart for typical
 * vision and for simulated protanopia, deuteranopia and tritanopia.
 */
export const botPalette = {
  red: themed("oklch(0.441 0.179 29)", "oklch(0.555 0.193 33)"),
  orange: themed("oklch(0.535 0.11 72)", "oklch(0.682 0.132 57)"),
  yellow: themed("oklch(0.621 0.125 86)", "oklch(0.79 0.162 94)"),
  green: themed("oklch(0.401 0.091 159)", "oklch(0.812 0.104 149)"),
  teal: themed("oklch(0.61 0.102 206)", "oklch(0.708 0.093 189)"),
  blue: themed("oklch(0.516 0.124 243)", "oklch(0.596 0.217 271)"),
  indigo: themed("oklch(0.322 0.193 281)", "oklch(0.72 0.151 295)"),
  violet: themed("oklch(0.622 0.183 295)", "oklch(0.523 0.148 298)"),
  pink: themed("oklch(0.451 0.136 336)", "oklch(0.584 0.094 349)"),
  gray: themed("oklch(0.532 0 0)", "oklch(0.93 0 0)"),
} as const satisfies Record<BotColor, Themed>;

/**
 * The three faces J3 Bots bundles (`fonts/`, under the SIL Open Font License),
 * each with the platform's own as its fallback while it loads.
 */
export const fontFamilies = {
  /** Headings, names on a profile, the first run: Bricolage Grotesque, bold only. */
  display: "Bricolage Grotesque",
  /** Everything else that is read: Instrument Sans, regular, medium and semibold. */
  text: "Instrument Sans",
  /** Code, commands and the steps of a turn: JetBrains Mono, regular, without ligatures. */
  mono: "JetBrains Mono",
} as const;

export const fonts = {
  display: `"${fontFamilies.display}", "${fontFamilies.text}", system-ui, sans-serif`,
  sans: `"${fontFamilies.text}", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
  mono: `"${fontFamilies.mono}", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
} as const;

/** Each face's files in `fonts/`, by weight. */
export const fontFaces = [
  { family: fontFamilies.display, weight: 700, file: "BricolageGrotesque-Bold" },
  { family: fontFamilies.text, weight: 400, file: "InstrumentSans-Regular" },
  { family: fontFamilies.text, weight: 500, file: "InstrumentSans-Medium" },
  { family: fontFamilies.text, weight: 600, file: "InstrumentSans-SemiBold" },
  { family: fontFamilies.mono, weight: 400, file: "JetBrainsMono-Regular" },
] as const;

/**
 * Size and line height in px. Message text is `base` on pointer devices and
 * `lg` on phones. From `2xl` up the steps are for the display face.
 */
export const typeScale = {
  "2xs": { size: 11, lineHeight: 16 },
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 18 },
  base: { size: 14, lineHeight: 20 },
  md: { size: 15, lineHeight: 20 },
  lg: { size: 16, lineHeight: 24 },
  xl: { size: 20, lineHeight: 26 },
  "2xl": { size: 24, lineHeight: 28 },
  "3xl": { size: 30, lineHeight: 34 },
  "4xl": { size: 40, lineHeight: 42 },
} as const;

export const fontWeights = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

/** The display face is set tight: its letter spacing, in em. */
export const displayTracking = -0.035;

/** Every spacing value is a multiple of this, in px. */
export const spacingUnit = 4;

/** Corner radii in px. Soft and round: buttons are pills, cards and dialogs well rounded. */
export const radii = {
  /** Badges, a key cap, a checkbox, the tightened corner of a bubble. */
  sm: 6,
  /** Fields, menu rows, the search field, small tiles. */
  md: 12,
  /** Roster rows, popovers, menus, cards. */
  lg: 16,
  /** Dialogs. */
  xl: 20,
  /** The top corners of a sheet that rises from the bottom of a phone. */
  sheet: 28,
  bubble: 20,
  /** Buttons, the composer, switches, chips. */
  pill: 9999,
} as const;

/**
 * Durations in ms, for what is not a spring: a color or opacity change. Moves
 * use `springs` (springs.ts).
 */
export const motion = {
  /** Hover and press color feedback. */
  fast: 150,
  /** A change of state's color or opacity, played once. */
  state: 200,
  /** A scrim or a larger fade. */
  slow: 300,
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
  rowHeight: { pointer: 56, touch: 64 },
  /** A button's or a field's height: compact for a mouse, the touch target on a touch screen. */
  controlHeight: { pointer: 36, touch: 44 },
  /** Minimum touch target. */
  touchTarget: 44,
  /**
   * Widest a bubble or a card in the timeline grows; on narrow columns they
   * keep a share of it free, so the two sides of a conversation stay apart.
   */
  entryWidth: { max: 576, bubbleShare: 0.85, cardShare: 0.92 },
  /** Compact cards in the timeline: a handoff, a routine change. */
  compactCardWidth: 448,
  /** The composer grows with its text up to this height, then scrolls. */
  composerMaxHeight: 240,
  /** Below `tablet` one region shows at a time; from `wide` the details pane sits beside the conversation. */
  breakpoints: { tablet: 768, wide: 1200 },
} as const;
