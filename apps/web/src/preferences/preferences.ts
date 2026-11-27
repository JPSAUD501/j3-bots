// SPDX-License-Identifier: AGPL-3.0-or-later
import { LANGUAGES, ThemeId } from "@j3-bots/contracts";
import { colors } from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { drawLook, keepLook, LOOK_KEY, lookFrom, storedLook, type ThemeLook } from "../themes/look";

/**
 * The operator's appearance, theme and language choices for this browser. The
 * appearance and the language default to following the system, and the theme
 * to the server's default. index.html reads the appearance key, and the look
 * of the theme shown last (`themes/look.ts`), before the first paint.
 */

const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;

const LanguageChoice = Schema.Literals(["system", ...LANGUAGES]);
export type LanguageChoice = typeof LanguageChoice.Type;

const KEYS = { appearance: "j3:appearance", language: "j3:language", theme: "j3:theme" } as const;

interface Preferences {
  readonly appearance: Appearance;
  readonly language: LanguageChoice;
  /** The theme this browser shows, as its person picked it; null to show the server's default. */
  readonly themeId: ThemeId | null;
  /** The theme in effect once "system" is resolved. */
  readonly theme: "light" | "dark";
  /** The look of the theme this browser shows, null for the stock one. */
  readonly look: ThemeLook | null;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the default applies.
    return null;
  }
}

function readStored<A extends string>(key: string, schema: Schema.Codec<A>, fallback: A): A {
  return Option.getOrElse(Schema.decodeUnknownOption(schema)(readRaw(key)), () => fallback);
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === "system" || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The choice still applies to this page; it is just not remembered.
  }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

let look = storedLook();

function compute(): Preferences {
  const appearance = readStored(KEYS.appearance, Appearance, "system");
  const language = readStored(KEYS.language, LanguageChoice, "system");
  const themeId = Option.getOrNull(Schema.decodeUnknownOption(ThemeId)(readRaw(KEYS.theme)));
  const theme = appearance === "system" ? (systemDark.matches ? "dark" : "light") : appearance;
  return { appearance, language, themeId, theme, look };
}

/**
 * The browser's own chrome, such as an installed app's title bar or a phone's
 * address bar, in the theme's canvas. The page carries one `theme-color` for
 * each system appearance; with one chosen, both give its canvas.
 */
function applyThemeColor({ appearance, theme }: Preferences) {
  const canvas = {
    light: look?.window.light.background ?? colors.background.light,
    dark: look?.window.dark.background ?? colors.background.dark,
  };
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes("dark") ? "dark" : "light";
    meta.content = canvas[appearance === "system" ? own : theme];
  }
}

let snapshot = compute();
applyThemeColor(snapshot);

function refresh() {
  snapshot = compute();
  const root = document.documentElement;
  root.classList.toggle("dark", snapshot.theme === "dark");
  root.classList.toggle("light", snapshot.theme === "light");
  applyThemeColor(snapshot);
  for (const listener of listeners) listener();
}

systemDark.addEventListener("change", refresh);
window.addEventListener("storage", (event) => {
  if (event.key === LOOK_KEY) {
    // Another page of this app, such as the main window, changed the theme.
    look = lookFrom(event.newValue);
    drawLook(look);
    refresh();
  }
  if (event.key === KEYS.appearance || event.key === KEYS.language || event.key === KEYS.theme) {
    refresh();
  }
});

export function setAppearance(appearance: Appearance) {
  writeStored(KEYS.appearance, appearance);
  refresh();
}

/** Shows `themeId` on this browser, or the server's default for null. */
export function setThemeId(themeId: ThemeId | null) {
  writeStored(KEYS.theme, themeId);
  refresh();
}

/** Draws the theme this browser shows, and keeps it for the next page. */
export function showLook(next: ThemeLook | null) {
  if (next?.id === look?.id && next?.colors === look?.colors && next?.css === look?.css) return;
  look = next;
  drawLook(next);
  keepLook(next);
  refresh();
}

export function setLanguage(language: LanguageChoice) {
  writeStored(KEYS.language, language);
  refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, () => snapshot);
}
