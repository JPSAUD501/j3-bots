// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type ThemeBackground,
  type ThemeDefinition,
  ThemeId,
  type ThemeLibrary,
} from "@j3-bots/contracts";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  type BuiltInThemeId,
  DEFAULT_THEME_ID,
  isThemeRole,
  resolveTheme,
  stockPalette,
  type ThemeColors,
  type ThemePalettes,
} from "@j3-bots/design-tokens";

/** Where a theme came from: J3 Bots, the operator's form, or a bot, null once deleted. */
export type ThemeOrigin =
  | { readonly _tag: "built-in"; readonly id: BuiltInThemeId }
  | { readonly _tag: "operator" }
  | { readonly _tag: "bot"; readonly botId: BotId | null };

/** A theme a device can show. */
export interface ThemeChoice {
  readonly id: ThemeId;
  readonly definition: ThemeDefinition;
  readonly origin: ThemeOrigin;
  readonly background: ThemeBackground | null;
}

const builtInChoice = (id: BuiltInThemeId): ThemeChoice => ({
  id: ThemeId.make(id),
  definition: BUILT_IN_THEMES[id],
  origin: { _tag: "built-in", id },
  background: null,
});

const BUILT_IN_CHOICES: ReadonlyArray<ThemeChoice> = BUILT_IN_THEME_IDS.map(builtInChoice);

const STOCK_CHOICE = builtInChoice(DEFAULT_THEME_ID);

/**
 * Every theme a device can show: the built-ins, in their order, then the
 * saved ones, newest first. `library` is null while it is not known, or the
 * server keeps no themes.
 */
export const themeChoices = (library: ThemeLibrary | null): ReadonlyArray<ThemeChoice> => [
  ...BUILT_IN_CHOICES,
  ...(library?.themes ?? []).map((theme): ThemeChoice => ({
    id: theme.id,
    definition: theme.definition,
    origin: theme.madeBy,
    background: theme.background,
  })),
];

/**
 * The theme a device shows: the one its person picked, else the server's
 * default, else the stock theme. Null while a saved theme it names may still
 * be in a library not received yet: the device keeps what it showed.
 */
export const shownTheme = (
  picked: string | null,
  library: ThemeLibrary | null,
  libraryKnown: boolean,
): ThemeChoice | null => {
  const choices = themeChoices(library);
  const find = (id: string | null) =>
    id === null ? undefined : choices.find((choice) => choice.id === id);
  const found = find(picked) ?? find(library?.defaultTheme ?? null);
  if (found !== undefined) return found;
  return libraryKnown ? STOCK_CHOICE : null;
};

/** The roles this release knows, of those a theme gives: a later release's are passed over. */
const known = (colors: ThemeColors | undefined): ThemeColors | undefined =>
  colors === undefined
    ? undefined
    : Object.fromEntries(Object.entries(colors).filter(([role]) => isThemeRole(role)));

const resolved = new WeakMap<ThemeDefinition, ThemePalettes>();

const STOCK: ThemePalettes = { light: stockPalette("light"), dark: stockPalette("dark") };

/**
 * Both palettes of a theme, derived as the server checked them. A theme a
 * later release saved, which this one cannot read whole, shows its roles this
 * release knows; one this release refuses outright shows the stock palettes.
 */
export const themePalettes = (definition: ThemeDefinition): ThemePalettes => {
  const cached = resolved.get(definition);
  if (cached !== undefined) return cached;
  const light = known(definition.variants?.light);
  const dark = known(definition.variants?.dark);
  const colors = known(definition.colors);
  const result = resolveTheme({
    name: definition.name,
    canvas: definition.canvas,
    accent: definition.accent,
    ...(colors === undefined ? {} : { colors }),
    ...(light === undefined && dark === undefined
      ? {}
      : {
          variants: {
            ...(light === undefined ? {} : { light }),
            ...(dark === undefined ? {} : { dark }),
          },
        }),
  });
  const palettes = result._tag === "resolved" ? result.palettes : STOCK;
  resolved.set(definition, palettes);
  return palettes;
};

/** Whether a theme is the stock look, which the app's own styles already draw. */
export const isStockTheme = (choice: ThemeChoice): boolean =>
  choice.id === DEFAULT_THEME_ID && choice.origin._tag === "built-in";
