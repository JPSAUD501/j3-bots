// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a theme reaches the page (decision 0104): its colors as a stylesheet
 * over the generated one, scoped to `:root[data-theme]` so it outranks the
 * generated sheet whichever loads last, its own CSS as a second one after
 * it, and its background image as `--theme-background-image`. Both are kept
 * in storage, so index.html puts them back before the first paint and every
 * page of this origin, such as quick access, shows the same theme. A change
 * is a stylesheet swap: no reload, and nothing redrawn frame after frame.
 *
 * The theme's own CSS is held off while Settings is open, so a theme can
 * never hide or disguise the way to another one.
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
 * Where the look is kept. index.html reads it before the first paint: keep
 * the key, the elements' ids and the fields in step with it.
 */
export const LOOK_KEY = "j3:theme-look";
const COLORS_ID = "j3-theme";
const OWN_CSS_ID = "j3-theme-css";

/**
 * A theme as the page draws it: its id, its colors' stylesheet, its own CSS
 * (empty where CSS is not allowed), and its canvas and surface in each
 * appearance as `#rrggbb`, which the browser's own chrome and the desktop
 * app's windows fill with before a page paints.
 */
const ThemeLook = Schema.Struct({
  id: Schema.String,
  colors: Schema.String,
  css: Schema.String,
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
  return {
    id: choice.id,
    colors: renderThemeColorsCss(palettes, THEME_ROOT),
    css: withCss ? (choice.definition.css ?? "") : "",
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

/** Whether Settings, open on this page, holds the theme's own CSS off. */
let ownCssHeld = false;

/** A `<style>` of the head, made the first time it is needed. */
function styleElement(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found !== null) return found;
  const style = document.createElement("style");
  style.id = id;
  document.head.append(style);
  return style;
}

/** Applies the theme's own CSS, or holds it off without dropping it. */
function placeOwnCss(style: HTMLElement) {
  if (ownCssHeld) style.setAttribute("media", "not all");
  else style.removeAttribute("media");
}

/** Draws `look` on this page, or the stock theme for null. */
export function drawLook(look: ThemeLook | null) {
  const root = document.documentElement;
  if (look === null) {
    document.getElementById(COLORS_ID)?.remove();
    document.getElementById(OWN_CSS_ID)?.remove();
    delete root.dataset.theme;
    return;
  }
  const colors = styleElement(COLORS_ID);
  if (colors.textContent !== look.colors) colors.textContent = look.colors;
  if (look.css === "") {
    document.getElementById(OWN_CSS_ID)?.remove();
  } else {
    const own = styleElement(OWN_CSS_ID);
    if (own.textContent !== look.css) own.textContent = look.css;
    placeOwnCss(own);
  }
  root.dataset.theme = look.id;
}

/**
 * Holds the theme's own CSS off this page while `held`: Settings shows in
 * the theme's colors alone, so whatever a theme's CSS hides or restyles, the
 * person can always see Settings and pick another theme there.
 */
export function holdOwnCss(held: boolean) {
  ownCssHeld = held;
  const own = document.getElementById(OWN_CSS_ID);
  if (own !== null) placeOwnCss(own);
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
