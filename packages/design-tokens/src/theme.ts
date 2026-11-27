// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Themes (decision 0104): a theme is data. Two colors, `canvas` and
 * `accent`, derive every interface role of both appearances; `colors` and
 * `variants` override single roles; `css` restyles the web and the desktop
 * app. Bot colors and state colors are not theme roles: the bots' palette is
 * their identity in every theme, and a state keeps its meaning, the theme
 * moving only its shade so it stays legible and apart from the accent.
 *
 * Every palette this module gives is checked with the WCAG math of
 * `color.ts` against the same rules as the stock tokens: a role that falls
 * short is moved in lightness until it reaches them, and a theme where that
 * cannot be done is refused with the reason. docs/design/themes.md has the
 * reasoning behind each offset.
 */
import { botBubbleIn, botPalette } from "./botPalette.ts";
import {
  contrastRatio,
  isColor,
  type LinearRgb,
  mixOklab,
  type Oklch,
  oklchText,
  over,
  parseColor,
  perceivedDistance,
  toOklch,
} from "./color.ts";
import { botColors } from "./names.ts";
import { themeCssProblem } from "./themeCss.ts";
import {
  type ColorRole,
  colors,
  type Palette,
  STATE_SURFACE_TONES,
  stockPalette,
  type Themed,
} from "./tokens.ts";

export type Appearance = keyof Themed;

export const APPEARANCES = ["light", "dark"] as const satisfies ReadonlyArray<Appearance>;

/**
 * The roles a theme sets: the interface's canvases, lines, text, bubbles and
 * accent. Every other color role (the states, the switch's thumb, the ink
 * drawn over a bot's color, the scrim, scrollbars and the image viewer)
 * stays as the tokens give it, or follows the theme's canvas without being
 * one of its roles.
 */
export const THEME_ROLES = [
  "background",
  "surface",
  "sidebar",
  "muted",
  "row-hover",
  "muted-strong",
  "border",
  "input",
  "foreground",
  "muted-foreground",
  "bubble-operator",
  "bubble-operator-foreground",
  "bubble-bot",
  "bubble-bot-foreground",
  "code-background",
  "accent",
  "accent-foreground",
  "control-off",
] as const satisfies ReadonlyArray<ColorRole>;

export type ThemeRole = (typeof THEME_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(THEME_ROLES);

export const isThemeRole = (name: string): name is ThemeRole => ROLE_SET.has(name);

/** What each role paints, for the guide a bot reads and the docs. */
export const THEME_ROLE_USES: Readonly<Record<ThemeRole, string>> = {
  background: "the conversation's canvas, behind everything",
  surface: "cards, popovers, dialogs, sheets and the composer",
  sidebar: "the list of bots and rooms",
  muted: "a quiet filled control, a field, and a selected row",
  "row-hover": "a row in the list under the pointer",
  "muted-strong": "a muted control under the pointer",
  border: "lines between areas and around cards",
  input: "the outline of fields and outline buttons",
  foreground: "text and icons",
  "muted-foreground": "secondary text: times, hints, a row's second line",
  "bubble-operator": "the person's own messages",
  "bubble-operator-foreground": "text in the person's messages",
  "bubble-bot": "a bot's messages outside its own conversation",
  "bubble-bot-foreground": "text in a bot's messages",
  "code-background": "code, laid over whatever it sits on (translucent works best)",
  accent: "focus rings, links, unread marks and the primary action",
  "accent-foreground": "text and icons drawn on the accent",
  "control-off": "the track of a switch that is off",
};

/** A seed color: one `#rrggbb` both appearances derive from, or one for each. */
export type ThemeSeed = string | { readonly light: string; readonly dark: string };

/** Role overrides: a role's name and its color, `#rrggbb` or `oklch(L C H[ / A])`. */
export type ThemeColors = Readonly<Record<string, string>>;

/** A theme as data: what is stored, what a bot writes, and what each built-in is. */
export interface ThemeDefinition {
  readonly name: string;
  readonly description?: string;
  /** The ground every surface is tinted from. */
  readonly canvas: ThemeSeed;
  /** Focus, links, unread, the primary action, and the person's own bubble. */
  readonly accent: ThemeSeed;
  /** Overrides for both appearances. */
  readonly colors?: ThemeColors;
  /** Overrides for one appearance, over `colors`. */
  readonly variants?: { readonly light?: ThemeColors; readonly dark?: ThemeColors };
  /** Custom styles, applied on the web and in the desktop app only. */
  readonly css?: string;
}

/** A theme's two palettes. */
export type ThemePalettes = Readonly<Record<Appearance, Palette>>;

/** A color the theme gave that was moved to keep the interface legible. */
export interface ThemeAdjustment {
  readonly appearance: Appearance;
  /** A theme role, or `canvas` or `accent` for a seed. */
  readonly role: string;
  readonly from: string;
  readonly to: string;
  /** Why, in English, for the bot that made the theme. */
  readonly reason: string;
}

export type ThemeResolution =
  | {
      readonly _tag: "resolved";
      readonly palettes: ThemePalettes;
      readonly adjustments: ReadonlyArray<ThemeAdjustment>;
    }
  | { readonly _tag: "refused"; readonly reason: string };

// ---------------------------------------------------------------------------
// Contrast rules: the same as the stock tokens are held to (tokens.test.ts).

const CANVASES = ["background", "surface", "sidebar", "muted"] as const;

/** Text against what it is drawn on: 4.5:1. */
const TEXT_GROUNDS = {
  foreground: ["background", "surface", "sidebar", "muted", "muted-strong"],
  "muted-foreground": ["background", "surface", "sidebar", "muted", "muted-strong", "bubble-bot"],
  "bubble-operator-foreground": ["bubble-operator"],
  "bubble-bot-foreground": ["bubble-bot"],
  accent: ["background", "surface", "sidebar", "muted"],
  "accent-foreground": ["accent"],
  waiting: ["background", "surface", "sidebar", "muted", "waiting-surface"],
  blocked: ["background", "surface", "sidebar", "muted", "blocked-surface"],
  success: ["background", "surface", "sidebar", "muted"],
} as const satisfies Partial<Record<ColorRole, ReadonlyArray<ColorRole>>>;

/** Marks and boundaries against every canvas: 3:1. */
const MARKS = [
  "accent",
  "waiting",
  "blocked",
  "success",
  "control-on",
  "control-off",
] as const satisfies ReadonlyArray<ColorRole>;

const TEXT = 4.5;
const MARK = 3;

/** How far apart, in OKLab, a state's color stays from the accent so neither reads as the other. */
export const STATE_ACCENT_DISTANCE = 0.09;

/** A role as it renders: a translucent one laid over the canvas. */
const rendered = (palette: Palette, role: ColorRole, base?: LinearRgb): LinearRgb => {
  const color = parseColor(palette[role]);
  return color.alpha < 1 ? over(color, base ?? parseColor(palette.background)) : color;
};

/** Whether a bot's body color in `appearance` reaches 3:1 against `ground`. */
const botsReadOn = (ground: LinearRgb, appearance: Appearance): boolean =>
  botColors.every(
    (color) => contrastRatio(parseColor(botPalette[color][appearance]), ground) >= MARK,
  );

/**
 * Every rule a palette breaks, as one English line each: empty when it
 * keeps them all. The stock tokens and every built-in theme keep them.
 */
export function paletteProblems(palette: Palette, appearance: Appearance): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const ratio = (a: LinearRgb, b: LinearRgb) => contrastRatio(a, b);
  for (const [fg, grounds] of Object.entries(TEXT_GROUNDS) as Array<
    [ColorRole, ReadonlyArray<ColorRole>]
  >) {
    for (const ground of grounds) {
      const value = ratio(rendered(palette, fg), rendered(palette, ground));
      if (value < TEXT) problems.push(`${fg} on ${ground} is ${value.toFixed(2)}:1, under 4.5:1`);
    }
  }
  for (const mark of MARKS) {
    for (const ground of CANVASES) {
      const value = ratio(rendered(palette, mark), rendered(palette, ground));
      if (value < MARK) problems.push(`${mark} on ${ground} is ${value.toFixed(2)}:1, under 3:1`);
    }
  }
  for (const track of ["control-on", "control-off"] as const) {
    const value = ratio(rendered(palette, "control-thumb"), rendered(palette, track));
    if (value < MARK) problems.push(`the switch's thumb on ${track} is ${value.toFixed(2)}:1`);
  }
  for (const ground of CANVASES) {
    if (!botsReadOn(rendered(palette, ground), appearance)) {
      problems.push(`a bot's color falls under 3:1 on ${ground}`);
    }
  }
  for (const [fg, bubble] of [
    ["bubble-bot-foreground", "bubble-bot"],
    ["bubble-operator-foreground", "bubble-operator"],
  ] as const) {
    const code = rendered(palette, "code-background", rendered(palette, bubble));
    if (ratio(rendered(palette, fg), code) < TEXT) problems.push(`code in ${bubble} is unreadable`);
  }
  const text = rendered(palette, "bubble-bot-foreground");
  for (const color of botColors) {
    const bubble = parseColor(botBubbleIn(color, palette, appearance));
    if (ratio(text, bubble) < TEXT) problems.push(`text in a ${color} bot's bubble is unreadable`);
  }
  for (const state of ["waiting", "blocked", "success"] as const) {
    const apart = perceivedDistance(
      rendered(palette, state),
      rendered(palette, "accent"),
      "typical",
    );
    if (apart < STATE_ACCENT_DISTANCE) problems.push(`${state} is too close to the accent`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Derivation.

const DARK = "dark";

/** The OKLCH of a seed in one appearance. */
const seedOf = (seed: ThemeSeed, appearance: Appearance): string =>
  typeof seed === "string" ? seed : seed[appearance];

const text = (color: Oklch) => oklchText(color);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Where a single canvas seed lands in `appearance`: as it is when it is
 * dark enough for the dark appearance or light enough for the light one,
 * and otherwise its hue and some of its chroma at that appearance's usual
 * lightness.
 */
const placeCanvas = (seed: string, appearance: Appearance): Oklch => {
  const color = toOklch(seed);
  if (appearance === DARK) {
    return color.l <= 0.32 ? color : { l: 0.2, c: Math.min(color.c, 0.035), h: color.h };
  }
  return color.l >= 0.9 ? color : { l: 0.975, c: Math.min(color.c, 0.012), h: color.h };
};

/** The roles canvas and accent derive in one appearance, before any is checked. */
function derivedRoles(
  canvas: Oklch,
  accent: Oklch,
  appearance: Appearance,
  /** The seeds as given, where they are used as they are: a role keeps the theme's own notation. */
  given: { readonly background: string; readonly accent: string },
) {
  const { l, c, h } = canvas;
  const at = (dl: number, chroma: number, alpha?: number): Oklch => ({
    l: clamp01(l + dl),
    c: chroma,
    h,
    ...(alpha === undefined ? {} : { alpha }),
  });
  if (appearance === DARK) {
    return {
      background: given.background,
      sidebar: text(at(-0.02, c * 0.85)),
      surface: text(at(0.035, c * 1.3)),
      muted: text(at(0.075, c * 1.6)),
      "muted-strong": text(at(0.11, c * 1.8)),
      border: text({ l: 0.97, c: Math.min(0.05, c * 3), h, alpha: 0.09 }),
      input: text({ l: 0.97, c: Math.min(0.05, c * 3), h, alpha: 0.15 }),
      foreground: text({ l: 0.945, c: Math.min(0.02, Math.max(0.004, c * 0.9)), h }),
      "muted-foreground": text({ l: 0.725, c: Math.min(0.045, c * 1.4 + 0.008), h }),
      "bubble-operator": text({ l: 0.36, c: Math.min(0.1, accent.c * 0.5), h: accent.h }),
      "code-background": colors["code-background"].dark,
      accent: given.accent,
      "accent-foreground": text({ l: 0.22, c: Math.min(0.06, accent.c * 0.35), h: accent.h }),
      "control-off": text({ l: 0.53, c: Math.min(0.03, c), h }),
    };
  }
  return {
    background: given.background,
    sidebar: text(at(-0.025, c * 1.6)),
    surface: text({ l: Math.min(1, l + 0.025), c: c * 0.4, h }),
    muted: text(at(-0.05, c * 2.4)),
    "muted-strong": text(at(-0.085, c * 2.6)),
    border: text(at(-0.07, c * 2.8)),
    input: text(at(-0.15, c * 3)),
    foreground: text({ l: 0.245, c: Math.min(0.04, c * 2 + 0.012), h }),
    "muted-foreground": text({ l: 0.51, c: Math.min(0.045, c * 2.5 + 0.012), h }),
    "bubble-operator": text({ l: accent.l - 0.03, c: accent.c, h: accent.h }),
    "code-background": colors["code-background"].light,
    accent: given.accent,
    "accent-foreground": text({ l: Math.min(1, l + 0.025), c: c * 0.4, h }),
    "control-off": text({ l: 0.6, c: Math.min(0.03, c), h }),
  };
}

/** Lightness `color` reaches `min` contrast against every ground at, moving `direction`, or null. */
function solveLightness(
  color: Oklch,
  grounds: ReadonlyArray<LinearRgb>,
  min: number,
  direction: "lighter" | "darker",
): Oklch | null {
  const reaches = (candidate: Oklch) => {
    const rgb = parseColor(oklchText(candidate));
    return grounds.every((ground) => contrastRatio(rgb, ground) >= min);
  };
  if (reaches(color)) return color;
  const end = direction === "lighter" ? 1 : 0;
  if (!reaches({ ...color, l: end })) return null;
  let near = color.l;
  let far = end;
  for (let step = 0; step < 24; step++) {
    const middle = (near + far) / 2;
    if (reaches({ ...color, l: middle })) far = middle;
    else near = middle;
  }
  // A step past the boundary, so the three places written still reach it.
  const nudge = direction === "lighter" ? 0.001 : -0.001;
  return { ...color, l: clamp01(far + nudge) };
}

interface Draft {
  roles: Record<ColorRole, string>;
  readonly explicit: ReadonlySet<string>;
  readonly adjustments: Array<ThemeAdjustment>;
  readonly appearance: Appearance;
}

const groundsOf = (draft: Draft, roles: ReadonlyArray<ColorRole>): ReadonlyArray<LinearRgb> =>
  roles.map((role) => rendered(draft.roles, role));

/** Sets `role` to `next`, noting it when the theme had given it. */
function move(draft: Draft, role: ColorRole, next: string, reason: string) {
  const from = draft.roles[role];
  if (from === next) return;
  draft.roles[role] = next;
  if (draft.explicit.has(role)) {
    draft.adjustments.push({ appearance: draft.appearance, role, from, to: next, reason });
  }
}

/**
 * A step of the derivation: it moves roles in `draft`, and gives the rule it
 * cannot keep at any lightness, which refuses the theme, or nothing.
 */
type Problem = string | undefined;

/** Moves `role` in lightness until it reaches `min` against `grounds`. */
function reach(
  draft: Draft,
  role: ColorRole,
  grounds: ReadonlyArray<ColorRole>,
  min: number,
  direction: "lighter" | "darker",
): Problem {
  const current = toOklch(draft.roles[role]);
  const solved = solveLightness(current, groundsOf(draft, grounds), min, direction);
  if (solved === null) {
    return `in ${draft.appearance}, ${role} cannot reach ${min}:1 against ${grounds.join(", ")} at any lightness`;
  }
  if (solved !== current) {
    move(
      draft,
      role,
      oklchText(solved),
      `made ${direction} to reach ${min}:1 on ${grounds.join(", ")}`,
    );
  }
  return undefined;
}

/** Moves `role` in lightness until it reaches 4.5:1 against every one of `grounds`. */
function reachOn(
  draft: Draft,
  role: ColorRole,
  grounds: ReadonlyArray<LinearRgb>,
  direction: "lighter" | "darker",
  purpose: string,
): Problem {
  const current = toOklch(draft.roles[role]);
  const solved = solveLightness(current, grounds, TEXT, direction);
  if (solved === null)
    return `in ${draft.appearance}, no ${role} is light or dark enough ${purpose}`;
  if (solved !== current) move(draft, role, oklchText(solved), `made ${direction} ${purpose}`);
  return undefined;
}

/** Moves a canvas away from the bots' colors until every bot reads on it at 3:1. */
function keepBotsReadable(draft: Draft, role: (typeof CANVASES)[number]): Problem {
  const current = toOklch(draft.roles[role]);
  if (botsReadOn(rendered(draft.roles, role), draft.appearance)) return undefined;
  const dark = draft.appearance === DARK;
  let near = current.l;
  let far = dark ? 0 : 1;
  const at = (l: number) => parseColor(oklchText({ ...current, l }));
  if (!botsReadOn(at(far), draft.appearance)) {
    return `in ${draft.appearance}, no ${role} keeps every bot's color readable`;
  }
  for (let step = 0; step < 24; step++) {
    const middle = (near + far) / 2;
    if (botsReadOn(at(middle), draft.appearance)) far = middle;
    else near = middle;
  }
  move(
    draft,
    role,
    oklchText({ ...current, l: clamp01(far + (dark ? -0.001 : 0.001)) }),
    `made ${dark ? "darker" : "lighter"} so every bot's color reads on it at 3:1`,
  );
  return undefined;
}

/**
 * A state's color moved in lightness and a little in hue, within its own
 * family, until it is apart from the accent and readable on the canvases.
 */
function separateState(draft: Draft, state: "waiting" | "blocked" | "success"): Problem {
  const accent = rendered(draft.roles, "accent");
  const base = toOklch(draft.roles[state]);
  const accentOk = toOklch(draft.roles.accent);
  const grounds = groundsOf(draft, TEXT_GROUNDS[state]);
  const fits = (candidate: Oklch) => {
    const rgb = parseColor(oklchText(candidate));
    return (
      perceivedDistance(rgb, accent, "typical") >= STATE_ACCENT_DISTANCE &&
      grounds.every((ground) => contrastRatio(rgb, ground) >= TEXT)
    );
  };
  if (fits(base)) return undefined;
  // Away from the accent: in lightness, and in hue by at most 12°.
  const lightnessAway = base.l >= accentOk.l ? 1 : -1;
  const hueAway = ((base.h - accentOk.h + 540) % 360) - 180 >= 0 ? 1 : -1;
  for (let step = 1; step <= 30; step++) {
    for (const sign of [lightnessAway, -lightnessAway]) {
      const candidate = {
        l: clamp01(base.l + sign * step * 0.01),
        c: base.c,
        h: base.h + hueAway * Math.min(12, step),
      };
      if (fits(candidate)) {
        draft.roles[state] = oklchText(candidate);
        return undefined;
      }
    }
  }
  return `in ${draft.appearance}, ${state} cannot be kept apart from the accent`;
}

const STOCK_STATES = ["waiting", "blocked", "success", "control-on"] as const;

function resolveAppearance(
  definition: ThemeDefinition,
  appearance: Appearance,
  adjustments: Array<ThemeAdjustment>,
):
  | { readonly _tag: "palette"; readonly palette: Palette }
  | { readonly _tag: "refused"; readonly reason: string } {
  const dark = appearance === DARK;
  const canvasSeed = seedOf(definition.canvas, appearance);
  const accentSeed = seedOf(definition.accent, appearance);
  const canvas =
    typeof definition.canvas === "string"
      ? placeCanvas(canvasSeed, appearance)
      : toOklch(canvasSeed);
  if (text(canvas) !== text(toOklch(canvasSeed))) {
    adjustments.push({
      appearance,
      role: "canvas",
      from: canvasSeed,
      to: text(canvas),
      reason: `a single canvas is placed at the ${appearance} appearance's lightness, keeping its hue`,
    });
  }
  const accent = toOklch(accentSeed);
  const overrides: Record<string, string> = {
    ...definition.colors,
    ...definition.variants?.[appearance],
  };
  const placed = text(canvas) !== text(toOklch(canvasSeed));
  const derived = derivedRoles(canvas, accent, appearance, {
    background: placed ? text(canvas) : canvasSeed,
    accent: accentSeed,
  });
  const roles = stockPalette(appearance);
  // The seeds count as given too: a canvas or accent that had to move is told.
  const explicit = new Set([...Object.keys(overrides), "background", "accent"]);
  const draft: Draft = { roles, explicit, adjustments, appearance };
  const take = (role: ThemeRole, fallback: string) => {
    roles[role] = overrides[role] ?? fallback;
  };

  for (const role of CANVASES) take(role, derived[role]);
  const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
  for (const role of CANVASES) {
    const problem = keepBotsReadable(draft, role);
    if (problem !== undefined) return refused(problem);
  }
  take("row-hover", mixOklab(roles.muted, roles.sidebar, 0.55));
  take("muted-strong", derived["muted-strong"]);
  take("border", derived.border);
  take("input", derived.input);
  take("code-background", derived["code-background"]);
  take("bubble-bot", roles.muted);
  take("foreground", derived.foreground);
  take("bubble-bot-foreground", roles.foreground);
  take("muted-foreground", derived["muted-foreground"]);
  take("accent", derived.accent);
  take("accent-foreground", derived["accent-foreground"]);
  take("control-off", derived["control-off"]);

  const away = dark ? "lighter" : "darker";
  // What is drawn on a fill goes the other way from it.
  const onFill = (role: ColorRole) => (toOklch(roles[role]).l > 0.6 ? "darker" : "lighter");
  const unreadable =
    reach(draft, "foreground", TEXT_GROUNDS.foreground, TEXT, away) ??
    reach(draft, "muted-foreground", TEXT_GROUNDS["muted-foreground"], TEXT, away) ??
    reach(draft, "accent", TEXT_GROUNDS.accent, TEXT, away) ??
    reach(draft, "accent-foreground", ["accent"], TEXT, onFill("accent"));
  if (unreadable !== undefined) return refused(unreadable);

  // The person's bubble is the accent as it reads, in the light appearance.
  const accentShown = toOklch(roles.accent);
  take(
    "bubble-operator",
    dark
      ? derived["bubble-operator"]
      : oklchText({ l: accentShown.l - 0.03, c: accentShown.c, h: accentShown.h }),
  );
  take("bubble-operator-foreground", dark ? roles.foreground : roles["accent-foreground"]);
  // Text in a bubble reads on it and on code laid over it; a bot's, on every bot's tint too.
  const withCode = (bubble: ColorRole) => {
    const ground = rendered(roles, bubble);
    return [ground, rendered(roles, "code-background", ground)];
  };
  const bubbles =
    reachOn(
      draft,
      "bubble-operator-foreground",
      withCode("bubble-operator"),
      onFill("bubble-operator"),
      "to read in the person's bubble",
    ) ??
    reachOn(
      draft,
      "bubble-bot-foreground",
      [
        ...withCode("bubble-bot"),
        ...botColors.map((color) => parseColor(botBubbleIn(color, roles, appearance))),
      ],
      away,
      "to read in every bot's bubble",
    );
  if (bubbles !== undefined) return refused(bubbles);
  // A switch's track: 3:1 against the canvases, and its light thumb 3:1 on it.
  const track = reach(draft, "control-off", CANVASES, MARK, away);
  if (track !== undefined) return refused(track);

  // The states follow the canvas: their surfaces are mixed over it, and
  // their colors keep their hue, moving only in lightness.
  for (const [surface, mix] of Object.entries(STATE_SURFACE_TONES) as Array<
    [
      keyof typeof STATE_SURFACE_TONES,
      (typeof STATE_SURFACE_TONES)[keyof typeof STATE_SURFACE_TONES],
    ]
  >) {
    roles[surface] = mixOklab(mix[appearance].tone, roles.background, mix[appearance].share);
  }
  for (const state of STOCK_STATES) {
    const grounds = state === "control-on" ? CANVASES : TEXT_GROUNDS[state];
    const min = state === "control-on" ? MARK : TEXT;
    const start = toOklch(roles[state]);
    const solved = solveLightness(start, groundsOf(draft, grounds), min, away);
    if (solved === null) return refused(`in ${appearance}, ${state} cannot be made readable`);
    if (solved !== start) roles[state] = oklchText(solved);
  }
  for (const state of ["waiting", "blocked", "success"] as const) {
    const problem = separateState(draft, state);
    if (problem !== undefined) return refused(problem);
  }

  // Whatever the steps could not move, such as a switch's track caught
  // between the canvas and its thumb, refuses the theme here.
  const [problem] = paletteProblems(roles, appearance);
  if (problem !== undefined) return refused(`in ${appearance}, ${problem}`);
  return { _tag: "palette", palette: roles };
}

/** Why the definition cannot be read as a theme, or null. */
function definitionProblem(definition: ThemeDefinition): string | null {
  for (const appearance of APPEARANCES) {
    for (const [name, seed] of [
      ["canvas", definition.canvas],
      ["accent", definition.accent],
    ] as const) {
      if (!/^#[0-9a-f]{6}$/i.test(seedOf(seed, appearance))) {
        return `\`${name}\` must be a #rrggbb color, or one for \`light\` and one for \`dark\`.`;
      }
    }
  }
  const layers: Array<[string, ThemeColors | undefined]> = [
    ["colors", definition.colors],
    ["variants.light", definition.variants?.light],
    ["variants.dark", definition.variants?.dark],
  ];
  for (const [where, layer] of layers) {
    for (const [role, value] of Object.entries(layer ?? {})) {
      if (!isThemeRole(role)) {
        return `\`${where}\` names \`${role}\`, which is not a theme role. The roles are: ${THEME_ROLES.join(", ")}.`;
      }
      if (!isColor(value)) {
        return `\`${where}.${role}\` is \`${value}\`: give #rrggbb or oklch(L C H) with an optional / alpha.`;
      }
    }
  }
  const css = definition.css === undefined ? null : themeCssProblem(definition.css);
  if (css !== null) return css;
  const canvas = toOklch(seedOf(definition.canvas, "dark"));
  if (typeof definition.canvas !== "string") {
    if (canvas.l > 0.5)
      return "`canvas.dark` must be a dark color: the dark appearance is drawn on it.";
    if (toOklch(definition.canvas.light).l < 0.6) {
      return "`canvas.light` must be a light color: the light appearance is drawn on it.";
    }
  }
  return null;
}

/**
 * Both palettes of a theme, with each color it gave that had to move to keep
 * the interface legible, or why it cannot be a theme.
 */
export function resolveTheme(definition: ThemeDefinition): ThemeResolution {
  const problem = definitionProblem(definition);
  if (problem !== null) return { _tag: "refused", reason: problem };
  const adjustments: Array<ThemeAdjustment> = [];
  const light = resolveAppearance(definition, "light", adjustments);
  if (light._tag === "refused") return light;
  const dark = resolveAppearance(definition, "dark", adjustments);
  if (dark._tag === "refused") return dark;
  return {
    _tag: "resolved",
    palettes: { light: light.palette, dark: dark.palette },
    adjustments,
  };
}
