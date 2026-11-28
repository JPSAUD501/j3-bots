// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * J3 Bots' design tokens: the single source for every client's colors, type,
 * space, shape, motion and layout. The web stylesheet (`web.ts`) and the
 * mobile app's Uniwind theme (`uniwind.ts`) are generated from this file.
 *
 * Colors are `#rrggbb` or `oklch(L C H)`, optionally with `/ alpha`. The
 * reasoning behind the values is in docs/design/design-language.md.
 */
import { mixOklab } from "./color.ts";

export interface Themed {
  readonly light: string;
  readonly dark: string;
}

const themed = (light: string, dark: string): Themed => ({ light, dark });

/**
 * The tone each state's surface is mixed from, and how much of it goes over
 * the canvas: a theme mixes it over its own canvas (theme.ts), so the
 * surface follows the canvas and keeps the state's hue.
 */
export const STATE_SURFACE_TONES = {
  "waiting-surface": {
    light: { tone: "oklch(0.9 0.12 85)", share: 0.25 },
    dark: { tone: "oklch(0.7 0.15 70)", share: 0.3 },
  },
  "blocked-surface": {
    light: { tone: "oklch(0.9 0.06 20)", share: 0.25 },
    dark: { tone: "oklch(0.8 0.2 25)", share: 0.25 },
  },
} as const;

const stateSurface = (role: keyof typeof STATE_SURFACE_TONES, canvas: Themed): Themed => {
  const { light, dark } = STATE_SURFACE_TONES[role];
  return themed(
    mixOklab(light.tone, canvas.light, light.share),
    mixOklab(dark.tone, canvas.dark, dark.share),
  );
};

const background = themed("#ffffff", "#000000");
const sidebar = themed("#f6f6f7", "#09090a");
const muted = themed("#f0f0f2", "#19191c");

/**
 * Interface colors: near-monochrome chrome on a true-black dark canvas. Color
 * on screen belongs to the bots and to state; the focus ring, links and the
 * primary action are the text color.
 */
export const colors = {
  background,
  /** Cards, popovers, dialogs, sheets, the composer. */
  surface: themed("#ffffff", "#101012"),
  sidebar,
  /** A quiet filled control, a field, and the selection fill of a row. */
  muted,
  /** The hover fill of a row in the sidebar: most of the way from `sidebar` to `muted`, so selection stays a step stronger. */
  "row-hover": themed(
    mixOklab(muted.light, sidebar.light, 0.55),
    mixOklab(muted.dark, sidebar.dark, 0.55),
  ),
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
  "waiting-surface": stateSurface("waiting-surface", background),
  /** A turn cannot continue, and destructive actions. */
  blocked: themed("oklch(0.53 0.2 27)", "oklch(0.71 0.17 25)"),
  "blocked-surface": stateSurface("blocked-surface", background),
  success: themed("oklch(0.52 0.12 160)", "oklch(0.78 0.14 160)"),
  /**
   * The track of a switch that is on. Darker than `success` in dark, where the
   * light thumb needs 3:1 against it.
   */
  "control-on": themed("oklch(0.52 0.12 160)", "oklch(0.6 0.13 160)"),
  /** The track of a switch that is off: a boundary of 3:1 against every canvas. */
  "control-off": themed("#82828a", "#6b6b73"),
  /** The thumb of a switch, light in both themes, drawn inside its track. */
  "control-thumb": themed("#ffffff", "#f5f5f6"),
  /** Marks drawn over a bot's color, such as the composer's send arrow on the conversation's tint. */
  "avatar-ink": themed("#ffffff", "#0b0b0c"),
  /** The thumb of every scrollbar, thin and laid over whatever scrolls. */
  scrollbar: themed("oklch(0 0 0 / 0.22)", "oklch(1 0 0 / 0.22)"),
  /** Behind sheets and dialogs. */
  scrim: themed("oklch(0 0 0 / 0.3)", "oklch(0 0 0 / 0.62)"),
  /**
   * The image viewer's canvas, black in both themes, as an image is seen best
   * against it.
   */
  viewer: themed("#000000", "#000000"),
  /** The viewer's bar, laid over the image. */
  "viewer-bar": themed("oklch(0 0 0 / 0.6)", "oklch(0 0 0 / 0.6)"),
  /** Text and icons on the viewer. */
  "viewer-foreground": themed("#ffffff", "#ffffff"),
  /** A quieter line on the viewer, such as the image still loading. */
  "viewer-muted-foreground": themed("oklch(1 0 0 / 0.75)", "oklch(1 0 0 / 0.75)"),
  /** A button on the viewer under the pointer or a press. */
  "viewer-pressed": themed("oklch(1 0 0 / 0.15)", "oklch(1 0 0 / 0.15)"),
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
  /**
   * A roster row lifted off the list while it travels to its new place. In
   * `rgba()` with units on every length, so Android's `boxShadow` draws the same.
   */
  lift: themed(
    "0px 6px 16px -6px rgba(0, 0, 0, 0.22), 0px 1px 3px 0px rgba(0, 0, 0, 0.08)",
    "0px 6px 16px -6px rgba(0, 0, 0, 0.9), 0px 0px 0px 1px rgba(255, 255, 255, 0.09)",
  ),
  /** A switch's thumb, lifted off its track. */
  thumb: themed(
    "0 1px 3px oklch(0 0 0 / 0.2), 0 0 0 0.5px oklch(0 0 0 / 0.06)",
    "0 1px 3px oklch(0 0 0 / 0.5)",
  ),
} as const satisfies Record<string, Themed>;

export type ColorRole = keyof typeof colors;

const COLOR_ROLES = Object.keys(colors) as ReadonlyArray<ColorRole>;

/** Every color role of one appearance: the stock tokens', or a theme's (theme.ts). */
export type Palette = Readonly<Record<ColorRole, string>>;

/** Every color role of one appearance as the stock tokens give it: Palco's palette. */
export const stockPalette = (appearance: keyof Themed): Record<ColorRole, string> => {
  const palette: Partial<Record<ColorRole, string>> = {};
  for (const role of COLOR_ROLES) palette[role] = colors[role][appearance];
  return palette as Record<ColorRole, string>;
};

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

/** A size and its line height, in px (sp on Android). */
export interface TypeSize {
  readonly size: number;
  readonly lineHeight: number;
}

/**
 * A step of the type scale on each kind of screen: `pointer` where a mouse
 * leads, read close up, and `touch` on a phone, read at arm's length. A
 * client takes one set whole: Android always `touch`, the web `pointer`
 * unless its primary pointer is coarse.
 */
export interface TypeStep {
  readonly pointer: TypeSize;
  readonly touch: TypeSize;
}

const step = (pointer: TypeSize, touch: TypeSize = pointer): TypeStep => ({ pointer, touch });

/**
 * The type scale. Each step stands for the same roles on both kinds of
 * screen, so a screen names a step once and reads well on either:
 *
 * - `2xs`: metadata, such as a time, a status, a time between messages.
 * - `xs`: small labels, notices, code inside a message.
 * - `sm`: secondary text, such as a roster row's line, a hint, a control.
 * - `base`: names, menu items, a row's title; message text on a pointer screen.
 * - `lg`: message text and the composer on a touch screen.
 *
 * From `xl` up the steps are headings, the same on both; from `2xl` up they
 * are for the display face. On touch, names and message text share one size
 * and differ in leading: a paragraph needs more room between lines than a
 * one-line name. docs/design/design-language.md has the reasoning.
 */
export const typeScale = {
  "2xs": step({ size: 12, lineHeight: 16 }, { size: 13, lineHeight: 18 }),
  xs: step({ size: 13, lineHeight: 18 }, { size: 14, lineHeight: 20 }),
  sm: step({ size: 14, lineHeight: 20 }, { size: 16, lineHeight: 22 }),
  base: step({ size: 15, lineHeight: 22 }, { size: 17, lineHeight: 22 }),
  lg: step({ size: 16, lineHeight: 24 }, { size: 17, lineHeight: 24 }),
  xl: step({ size: 20, lineHeight: 26 }),
  "2xl": step({ size: 24, lineHeight: 28 }),
  "3xl": step({ size: 30, lineHeight: 34 }),
  "4xl": step({ size: 40, lineHeight: 42 }),
} as const satisfies Record<string, TypeStep>;

export type TypeInput = keyof TypeStep;

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
  /** The composer: a rounded rectangle at any height, never a pill. */
  composer: 22,
  /** Buttons, switches, chips. */
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
   * One line of status giving way to the next, on `eases.out`: the old line
   * leaves upward as the new one rises in.
   */
  swap: 260,
  /**
   * A bot's pointer gliding to where it points next, on `eases.glide`: this
   * long across half the picture or more, shorter for a shorter move (`glideFor`).
   */
  glide: 600,
  /** The shortest glide, for the smallest move. */
  glideShortest: 250,
} as const;

/**
 * How long a bot's pointer glides to its next spot, in ms. `share` is the
 * move's length as a share of the picture's diagonal. Short moves take less
 * time, so the pointer keeps up with a bot working in one place.
 */
export const glideFor = (share: number): number =>
  Math.round(
    motion.glideShortest +
      (motion.glide - motion.glideShortest) * Math.sqrt(Math.min(1, Math.max(0, share) / 0.5)),
  );

/**
 * When a bot's card comes and goes under a pointer (decision 0102), in ms.
 * `open`: how long the pointer rests on a bot's face or name, or the focus on
 * it, before the card opens, so passing over a list opens nothing. `close`:
 * how long after the pointer leaves both, so it can cross the gap to the
 * card. `switch`: another bot's card, while one is open.
 */
export const cardTiming = {
  open: 500,
  close: 250,
  switch: 150,
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
  /** The composer grows with its text up to this height, then scrolls. */
  composerMaxHeight: 240,
  /** Below `tablet` one region shows at a time; from `wide` the details pane sits beside the conversation. */
  breakpoints: { tablet: 768, wide: 1200 },
} as const;
