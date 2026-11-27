// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a theme reaches the app (decision 0104): its colors, in both
 * appearances, as the variables of Uniwind's two themes, so every class and
 * every `useColor` repaints in them at once, with no reload and nothing drawn
 * frame after frame. A theme's own CSS restyles the web and the desktop app
 * only, and never reaches here.
 *
 * The theme shown is kept, so the next launch paints it before the first
 * screen rather than flashing the stock theme while the library is on its way.
 */
import {
  isStockTheme,
  type ThemeChoice,
  themePalettes,
} from "@j3-bots/client-runtime/presentation";
import { ThemeDefinition } from "@j3-bots/contracts";
import {
  APPEARANCES,
  type Appearance,
  nativeThemeVariables,
  type Palette,
  stockPalette,
  type ThemePalettes,
} from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Storage } from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Uniwind } from "uniwind";

const LOOK_KEY = "j3:theme-look";

/** The theme kept for the next launch: the definition its colors derive from. */
const KeptLook = Schema.fromJsonString(Schema.Struct({ definition: ThemeDefinition }));
const decodeKept = Schema.decodeUnknownOption(KeptLook);
const encodeKept = Schema.encodeSync(KeptLook);

const STOCK: ThemePalettes = { light: stockPalette("light"), dark: stockPalette("dark") };

/**
 * What tells one look from another: the parts of a definition its colors
 * derive from. A theme whose colors were changed keeps its id, so the id
 * alone does not.
 */
const lookKey = (definition: ThemeDefinition | null): string =>
  definition === null
    ? ""
    : JSON.stringify([
        definition.canvas,
        definition.accent,
        definition.colors ?? null,
        definition.variants ?? null,
      ]);

let shown: { readonly key: string; readonly palettes: ThemePalettes } = {
  key: "",
  palettes: STOCK,
};
const listeners = new Set<() => void>();

const paint = (palettes: ThemePalettes) => {
  for (const appearance of APPEARANCES) {
    Uniwind.updateCSSVariables(appearance, nativeThemeVariables(palettes[appearance], appearance));
  }
};

/** Paints `definition`'s colors, or the stock ones for null, unless they show already. */
const show = (definition: ThemeDefinition | null): boolean => {
  const key = lookKey(definition);
  if (key === shown.key) return false;
  const palettes = definition === null ? STOCK : themePalettes(definition);
  paint(palettes);
  shown = { key, palettes };
  for (const listener of listeners) listener();
  return true;
};

/** Paints the theme shown last; the app calls it once, before its first screen. */
export function applyKeptLook(): void {
  let raw: string | null = null;
  try {
    raw = Storage.getItemSync(LOOK_KEY);
  } catch {
    // A store that cannot be read starts in the stock theme.
  }
  const kept = decodeKept(raw);
  if (Option.isSome(kept)) show(kept.value.definition);
}

/** Paints `choice` on this phone, and keeps it for the next launch. */
export function showTheme(choice: ThemeChoice): void {
  const definition = isStockTheme(choice) ? null : choice.definition;
  if (!show(definition)) return;
  try {
    if (definition === null) Storage.removeItemSync(LOOK_KEY);
    else Storage.setItemSync(LOOK_KEY, encodeKept({ definition }));
  } catch {
    // The theme still shows; the next launch starts in the stock theme until the library arrives.
  }
}

/** Calls `listener` after each change of the colors shown. Returns the function that stops it. */
export const subscribeLook = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The colors shown now, in each appearance, for what draws outside React. */
export const shownPalettes = (): ThemePalettes => shown.palettes;

/**
 * The colors shown now in `appearance`, for what takes a color as a value
 * rather than a class, as a bot's visual or a connector's app does.
 */
export function useShownPalette(appearance: Appearance): Palette {
  return useSyncExternalStore(subscribeLook, shownPalettes)[appearance];
}
