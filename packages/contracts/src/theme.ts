// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Themes (decision 0104). A theme is data (`ThemeDefinition`): a canvas and
 * an accent derive every interface color of both appearances, and `colors`,
 * `variants` and `css` refine it. `@j3-bots/design-tokens` derives and checks
 * the palettes; this file is only the shape that travels. The server keeps
 * the themes the operator and the bots made; the seven built-ins live in
 * every client and are never sent. Which theme a device shows is that
 * device's choice, as its appearance is, over a default the server keeps.
 */
import { BUILT_IN_THEME_IDS, THEME_CSS_MAX_LENGTH } from "@j3-bots/design-tokens";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { BotId, CommandId } from "./base.ts";
import { CommandError } from "./errors.ts";

const RESERVED: ReadonlySet<string> = new Set<string>(BUILT_IN_THEME_IDS);

/**
 * A theme's id: lowercase letters, digits and hyphens, up to 48. A built-in's
 * id names it; a saved theme's id is never a built-in's.
 */
export const ThemeId = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,47})$/)).pipe(
  Schema.brand("ThemeId"),
);
export type ThemeId = typeof ThemeId.Type;

/** A saved theme's id: any id that is not a built-in's. */
export const SavedThemeId = ThemeId.check(
  Schema.makeFilter((id: string) =>
    RESERVED.has(id) ? "That id is a built-in theme's; choose another." : true,
  ),
);

/** A seed color, `#rrggbb`. */
export const ThemeSeedColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

/** One seed for both appearances, or one for each. */
export const ThemeSeed = Schema.Union([
  ThemeSeedColor,
  Schema.Struct({ light: ThemeSeedColor, dark: ThemeSeedColor }),
]);
export type ThemeSeed = typeof ThemeSeed.Type;

/**
 * Role overrides, by role name. Keys stay open, so a client passes over a
 * role a later release adds; the server takes only roles it knows.
 */
export const ThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z-]{0,39}$/)),
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
).check(
  Schema.makeFilter((colors) => (Object.keys(colors).length > 40 ? "At most 40 roles." : true)),
);

export const THEME_NAME_LENGTH = 48;
export const THEME_DESCRIPTION_LENGTH = 160;

export const ThemeName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THEME_NAME_LENGTH),
);

/** A theme as data: what the operator's form, a bot's `theme_save` and a built-in all are. */
export const ThemeDefinition = Schema.Struct({
  name: ThemeName,
  description: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(THEME_DESCRIPTION_LENGTH)),
  ),
  canvas: ThemeSeed,
  accent: ThemeSeed,
  colors: Schema.optionalKey(ThemeColors),
  variants: Schema.optionalKey(
    Schema.Struct({
      light: Schema.optionalKey(ThemeColors),
      dark: Schema.optionalKey(ThemeColors),
    }),
  ),
  /** Applied by the web client and the desktop app only. */
  css: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH))),
});
export type ThemeDefinition = typeof ThemeDefinition.Type;

/** Who made a saved theme: the operator, in Settings, or a bot. */
export const ThemeMaker = Schema.Union([
  Schema.TaggedStruct("operator", {}),
  Schema.TaggedStruct("bot", { botId: BotId }),
]);
export type ThemeMaker = typeof ThemeMaker.Type;

/** The image a theme shows behind the conversation: what it is, and its revision. */
export const ThemeBackground = Schema.Struct({
  /** Changes with each new image, so a client caching one by it fetches the next. */
  revision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  mediaType: Schema.Literals(["image/jpeg", "image/png", "image/webp"]),
});
export type ThemeBackground = typeof ThemeBackground.Type;

/** A theme the server keeps. */
export const SavedTheme = Schema.Struct({
  id: ThemeId,
  definition: ThemeDefinition,
  madeBy: ThemeMaker,
  /** Null when the theme has no image. */
  background: Schema.NullOr(ThemeBackground),
  updatedAt: Schema.DateTimeUtc,
});
export type SavedTheme = typeof SavedTheme.Type;

/**
 * What `themes.subscribe` sends: every saved theme, newest first, and the
 * theme a device shows until its person picks one. The default may name a
 * built-in or a saved theme.
 */
export const ThemeLibrary = Schema.Struct({
  themes: Schema.Array(SavedTheme),
  defaultTheme: ThemeId,
});
export type ThemeLibrary = typeof ThemeLibrary.Type;

/** The most bytes a theme's background image takes. */
export const MAX_THEME_BACKGROUND_SIZE = 4 * 1024 * 1024;

const command = { commandId: CommandId };

/**
 * The saved themes and the default. A client calls these only on a server
 * whose roster snapshot carries `themes`.
 */
export const ThemeRpcs = RpcGroup.make(
  /** The library now, then the whole library again after each change, whoever made it. */
  Rpc.make("themes.subscribe", { success: ThemeLibrary, stream: true }),
  /**
   * Saves a theme the operator made: a new one without `themeId`, which the
   * server names from the theme's name, or a change to the saved theme
   * `themeId`. `Invalid("theme")` for a definition `@j3-bots/design-tokens`
   * refuses, `NotFound("theme")` for an id with no saved theme. Answers the
   * theme as saved.
   */
  Rpc.make("theme.save", {
    payload: { ...command, themeId: Schema.optionalKey(SavedThemeId), definition: ThemeDefinition },
    success: SavedTheme,
    error: CommandError,
  }),
  /**
   * Deletes a saved theme, and its image. A device that showed it shows the
   * default; a default that named it goes back to the stock theme.
   */
  Rpc.make("theme.delete", { payload: { ...command, themeId: SavedThemeId }, error: CommandError }),
  /** The theme a device shows until its person picks one: a built-in or a saved theme. */
  Rpc.make("theme.setDefault", { payload: { ...command, themeId: ThemeId }, error: CommandError }),
);
