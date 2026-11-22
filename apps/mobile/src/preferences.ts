// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Language, LANGUAGES } from "@j3-bots/contracts";
import { createI18n, type I18n, resolveLocale } from "@j3-bots/i18n";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { getLocales } from "expo-localization";
import { Storage } from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Uniwind } from "uniwind";
import { keepNightMode } from "./platform/nightMode.ts";

// The operator's appearance and language for this phone. Both default to
// following the system. They are the phone's, not a pairing's: signing out
// keeps them. They are read synchronously, before the first screen, from
// expo-sqlite's key-value store, which is a database of its own.

const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;

const LanguageChoice = Schema.Literals(["system", ...LANGUAGES]);
export type LanguageChoice = typeof LanguageChoice.Type;

const KEYS = { appearance: "j3:appearance", language: "j3:language" } as const;

interface Preferences {
  readonly appearance: Appearance;
  readonly language: LanguageChoice;
}

function readStored<A extends string>(key: string, schema: Schema.Codec<A>, fallback: A): A {
  let raw: string | null = null;
  try {
    raw = Storage.getItemSync(key);
  } catch {
    // A store that cannot be read leaves the default, which follows the system.
  }
  return Option.getOrElse(Schema.decodeUnknownOption(schema)(raw), () => fallback);
}

function writeStored(key: string, value: string) {
  try {
    if (value === "system") Storage.removeItemSync(key);
    else Storage.setItemSync(key, value);
  } catch {
    // The choice still applies until the app restarts; it is just not remembered.
  }
}

let current: Preferences = {
  appearance: readStored(KEYS.appearance, Appearance, "system"),
  language: readStored(KEYS.language, LanguageChoice, "system"),
};
const listeners = new Set<() => void>();

const update = (next: Preferences) => {
  current = next;
  for (const listener of listeners) listener();
};

/**
 * Applies `appearance` to everything that draws in a theme: Uniwind's theme,
 * which also sets the color scheme React Native reports, which the navigation
 * and the system bars follow; and the system's own record of it, for the
 * splash screen of the next launch.
 */
const apply = (appearance: Appearance) => {
  Uniwind.setTheme(appearance);
  keepNightMode(appearance);
};

/** Applies the saved appearance; the app calls it once before its first screen. */
export const applyAppearance = (): void => apply(current.appearance);

export function setAppearance(appearance: Appearance): void {
  writeStored(KEYS.appearance, appearance);
  apply(appearance);
  update({ ...current, appearance });
}

export function setLanguage(language: LanguageChoice): void {
  writeStored(KEYS.language, language);
  update({ ...current, language });
}

/** Calls `listener` after each change of a preference. Returns the function that stops it. */
export const subscribePreferences = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const usePreferences = (): Preferences =>
  useSyncExternalStore(subscribePreferences, () => current);

/** The language chosen, or the first of the device's languages J3 Bots has: the one the app shows. */
export const shownLanguage = (choice: LanguageChoice = current.language): Language =>
  choice === "system" ? resolveLocale(getLocales().map((locale) => locale.languageTag)) : choice;

/** The catalog in the language chosen, or in the first of the device's languages J3 Bots has. */
export const i18nFor = (language: LanguageChoice): I18n => createI18n(shownLanguage(language));
