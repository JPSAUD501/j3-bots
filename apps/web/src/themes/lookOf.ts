// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isStockTheme,
  type ThemeChoice,
  themePalettes,
} from "@j3-bots/client-runtime/presentation";
import { hexColor, renderThemeColorsCss } from "@j3-bots/design-tokens";
import { THEME_ROOT, type ThemeLook } from "./look";

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
