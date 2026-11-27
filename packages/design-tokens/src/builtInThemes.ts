// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The themes J3 Bots ships, written in the format a bot writes one in
 * (`ThemeDefinition`), so each doubles as an example. Palco is the stock
 * tokens, every role given; the others give a canvas and an accent for each
 * appearance and let the derivation do the rest, overriding a role only
 * where the look asks for it.
 */
import { THEME_ROLES, type ThemeColors, type ThemeDefinition } from "./theme.ts";
import { colors, type Themed } from "./tokens.ts";

const stockRoles = (appearance: keyof Themed): ThemeColors =>
  Object.fromEntries(THEME_ROLES.map((role) => [role, colors[role][appearance]]));

export const BUILT_IN_THEME_IDS = [
  "palco",
  "grafite",
  "oceano",
  "floresta",
  "brasa",
  "lavanda",
  "papel",
] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];

/** The theme a device shows until the operator picks another or sets a different default. */
export const DEFAULT_THEME_ID: BuiltInThemeId = "palco";

export const BUILT_IN_THEMES: Readonly<Record<BuiltInThemeId, ThemeDefinition>> = {
  palco: {
    name: "Palco",
    description:
      "Monochrome, pure black in the dark. Colour belongs to the bots and to what needs you.",
    canvas: { light: "#ffffff", dark: "#000000" },
    accent: { light: "#101012", dark: "#f5f5f6" },
    variants: { light: stockRoles("light"), dark: stockRoles("dark") },
  },
  grafite: {
    name: "Graphite",
    description: "Bluish grey instead of pure black: softer for long hours with the app open.",
    canvas: { light: "#f4f6f9", dark: "#15171c" },
    accent: { light: "#3d6fd9", dark: "#8fb4ff" },
  },
  oceano: {
    name: "Ocean",
    description: "Deep petrol blue with a cyan accent. Calm, like the sea at night.",
    canvas: { light: "#f2fafb", dark: "#071a22" },
    accent: { light: "#0b8a9c", dark: "#3fd0e0" },
  },
  floresta: {
    name: "Forest",
    description: "Dark moss green with a mint accent. Natural and quiet.",
    canvas: { light: "#f4f8f4", dark: "#0d1712" },
    accent: { light: "#1f8a55", dark: "#6fdc9f" },
  },
  brasa: {
    name: "Ember",
    description: "Warm brown with a copper accent. Cosy, best at night.",
    canvas: { light: "#fbf6f2", dark: "#1a120e" },
    accent: { light: "#c4561b", dark: "#f08a4b" },
  },
  lavanda: {
    name: "Lavender",
    description: "Greyish purple with a lilac accent. Soft, with character.",
    canvas: { light: "#f8f6fc", dark: "#14111c" },
    accent: { light: "#7552d6", dark: "#b69cff" },
  },
  papel: {
    name: "Paper",
    description: "Warm cream with navy ink. Made for reading: it feels like a notebook.",
    canvas: { light: "#faf6ec", dark: "#1b1a17" },
    accent: { light: "#1f3f8a", dark: "#9db6e8" },
    // The ink: text takes the accent's navy rather than the paper's brown.
    variants: { light: { foreground: "#1f2a44" } },
  },
};

export const isBuiltInThemeId = (id: string): id is BuiltInThemeId =>
  (BUILT_IN_THEME_IDS as ReadonlyArray<string>).includes(id);
