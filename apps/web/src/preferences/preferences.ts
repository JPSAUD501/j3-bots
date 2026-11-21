// SPDX-License-Identifier: AGPL-3.0-or-later
import { LANGUAGES } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

/**
 * The operator's appearance and language choices for this browser. Both default
 * to following the system. index.html reads the appearance key before the
 * first paint.
 */

const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;

const Language = Schema.Literals(["system", ...LANGUAGES]);
export type Language = typeof Language.Type;

const KEYS = { appearance: "j3:appearance", language: "j3:language" } as const;

interface Preferences {
  readonly appearance: Appearance;
  readonly language: Language;
  /** The theme in effect once "system" is resolved. */
  readonly theme: "light" | "dark";
}

function readStored<A extends string>(key: string, schema: Schema.Codec<A>, fallback: A): A {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the default applies.
  }
  return Option.getOrElse(Schema.decodeUnknownOption(schema)(raw), () => fallback);
}

function writeStored(key: string, value: string) {
  try {
    if (value === "system") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The choice still applies to this page; it is just not remembered.
  }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function compute(): Preferences {
  const appearance = readStored(KEYS.appearance, Appearance, "system");
  const language = readStored(KEYS.language, Language, "system");
  const theme = appearance === "system" ? (systemDark.matches ? "dark" : "light") : appearance;
  return { appearance, language, theme };
}

let snapshot = compute();

function refresh() {
  snapshot = compute();
  const root = document.documentElement;
  root.classList.toggle("dark", snapshot.theme === "dark");
  root.classList.toggle("light", snapshot.theme === "light");
  for (const listener of listeners) listener();
}

systemDark.addEventListener("change", refresh);
window.addEventListener("storage", (event) => {
  if (event.key === KEYS.appearance || event.key === KEYS.language) refresh();
});

export function setAppearance(appearance: Appearance) {
  writeStored(KEYS.appearance, appearance);
  refresh();
}

export function setLanguage(language: Language) {
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
