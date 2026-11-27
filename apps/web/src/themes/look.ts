// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a theme reaches the page (decision 0104): its colors and its own CSS
 * as one stylesheet over the generated one, scoped to `:root[data-theme]` so
 * it outranks the generated sheet whichever loads last, and its background
 * image as `--theme-background-image`. The stylesheet is kept in storage, so
 * index.html puts it back before the first paint and every page of this
 * origin, such as quick access, shows the same theme. A change is one
 * stylesheet swap: no reload, and nothing redrawn frame after frame.
 */
import { hexColor, renderThemeColorsCss, THEME_BACKGROUND_VARIABLE } from "@j3-bots/design-tokens";
import { ThemeWindowColors } from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ThemeChoice } from "@j3-bots/client-runtime/presentation";
import { isStockTheme, themePalettes } from "@j3-bots/client-runtime/presentation";

/** The root's selector while a theme shows; index.html sets the attribute with the cached sheet. */
export const THEME_ROOT = ":root[data-theme]";

/**
 * Where the sheet is kept. index.html reads it before the first paint: keep
 * the key, the element's id and the fields in step with it.
 */
export const LOOK_KEY = "j3:theme-look";
const STYLE_ID = "j3-theme";

/**
 * A theme as the page draws it: its id, its stylesheet, its canvas in each
 * appearance, and what the desktop app's windows fill with before a page
 * paints, in each.
 */
const ThemeLook = Schema.Struct({
  id: Schema.String,
  css: Schema.String,
  canvas: Schema.Struct({ light: Schema.String, dark: Schema.String }),
  window: ThemeWindowColors,
});
export type ThemeLook = typeof ThemeLook.Type;

const decodeLook = Schema.decodeUnknownOption(Schema.fromJsonString(ThemeLook));

/**
 * The look of `choice` on this platform: its colors, and its own CSS where
 * `withCss` (the web and the desktop app), after them. None for the stock
 * theme, which the generated sheet already draws.
 */
export function lookOf(choice: ThemeChoice, withCss: boolean): ThemeLook | null {
  if (isStockTheme(choice)) return null;
  const palettes = themePalettes(choice.definition);
  const own = withCss ? (choice.definition.css ?? "") : "";
  return {
    id: choice.id,
    css: `${renderThemeColorsCss(palettes, THEME_ROOT)}\n${own}`,
    canvas: { light: palettes.light.background, dark: palettes.dark.background },
    window: {
      light: {
        background: hexColor(palettes.light.background),
        surface: hexColor(palettes.light.surface),
      },
      dark: {
        background: hexColor(palettes.dark.background),
        surface: hexColor(palettes.dark.surface),
      },
    },
  };
}

/** The look kept in storage, as index.html put it back. */
export function storedLook(): ThemeLook | null {
  try {
    return Option.getOrNull(decodeLook(localStorage.getItem(LOOK_KEY)));
  } catch {
    return null;
  }
}

/** Draws `look` on this page, or the stock theme for null. */
export function drawLook(look: ThemeLook | null) {
  const root = document.documentElement;
  let style = document.getElementById(STYLE_ID);
  if (look === null) {
    style?.remove();
    delete root.dataset.theme;
    return;
  }
  if (style === null) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== look.css) style.textContent = look.css;
  root.dataset.theme = look.id;
}

/** Keeps `look` for the next page, and for the other pages of this origin open now. */
export function keepLook(look: ThemeLook | null) {
  try {
    if (look === null) localStorage.removeItem(LOOK_KEY);
    else localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // The look still shows on this page; the next one starts from the stock theme.
  }
}

/** The look another page of this origin kept, from a `storage` event's new value. */
export const lookFrom = (stored: string | null): ThemeLook | null =>
  Option.getOrNull(decodeLook(stored));

/** Shows `url` behind the conversation, under a veil of the canvas, or nothing for null. */
export function applyBackground(url: string | null) {
  const root = document.documentElement;
  if (url === null) {
    root.style.removeProperty(THEME_BACKGROUND_VARIABLE);
    delete root.dataset.themeBackground;
  } else {
    root.style.setProperty(THEME_BACKGROUND_VARIABLE, `url("${url}")`);
    root.dataset.themeBackground = "";
  }
}
