// SPDX-License-Identifier: AGPL-3.0-or-later
/** The themes the sample server keeps, and the operator's changes to them. Development only. */
import { Invalid, type SavedTheme, ThemeId, type ThemeLibrary } from "@j3-bots/contracts";
import { isBuiltInThemeId, resolveTheme } from "@j3-bots/design-tokens";
import type { ThemesIntents } from "../shell/data";
import { ids, SAMPLE_NOW } from "./sample";

/** A theme Scout made: the one bot-made theme the gallery shows. */
const sampleBotTheme: SavedTheme = {
  id: ThemeId.make("low-tide"),
  definition: {
    name: "Low tide",
    description: "Sea-glass greens over wet sand, for long evenings of reading.",
    canvas: { light: "#f2f4ef", dark: "#0f1a19" },
    accent: { light: "#1f6f64", dark: "#7fd8c4" },
  },
  madeBy: { _tag: "bot", botId: ids.scout },
  background: null,
  updatedAt: SAMPLE_NOW,
};

export const sampleThemeLibrary: ThemeLibrary = {
  themes: [sampleBotTheme],
  defaultTheme: ThemeId.make("palco"),
};

/** An id for a new theme from its name, numbered past the ones taken, as the server makes one. */
const freshId = (name: string, taken: ReadonlyArray<ThemeId>): ThemeId => {
  const stem =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "theme";
  const free = (id: string) => !isBuiltInThemeId(id) && !taken.some((other) => other === id);
  let id = stem;
  for (let n = 2; !free(id); n++) id = `${stem}-${n}`;
  return ThemeId.make(id);
};

/** The sample server's theme intents over the library `get` reads and `set` replaces. */
export const sampleThemesIntents = ({
  get,
  set,
}: {
  readonly get: () => ThemeLibrary;
  readonly set: (library: ThemeLibrary) => void;
}): ThemesIntents => ({
  save: (definition, themeId) => {
    const library = get();
    if (resolveTheme(definition)._tag === "refused") {
      return Promise.resolve({
        _tag: "failed",
        failure: { _tag: "refused", error: new Invalid({ reason: "theme" }) },
      });
    }
    const before = library.themes.find((theme) => theme.id === themeId);
    const theme: SavedTheme = {
      id:
        before?.id ??
        freshId(
          definition.name,
          library.themes.map(({ id }) => id),
        ),
      definition,
      madeBy: { _tag: "operator" },
      background: before?.background ?? null,
      updatedAt: SAMPLE_NOW,
    };
    set({
      ...library,
      themes: [theme, ...library.themes.filter((other) => other.id !== theme.id)],
    });
    return Promise.resolve({ _tag: "done", value: theme });
  },
  remove: (themeId) => {
    const library = get();
    set({
      themes: library.themes.filter((theme) => theme.id !== themeId),
      defaultTheme: library.defaultTheme === themeId ? ThemeId.make("palco") : library.defaultTheme,
    });
    return Promise.resolve({ _tag: "done", value: undefined });
  },
  setDefault: (themeId) => {
    set({ ...get(), defaultTheme: themeId });
    return Promise.resolve({ _tag: "done", value: undefined });
  },
  // The sample's themes have no pictures.
  background: () => Promise.resolve({ _tag: "failed", reason: "not-found" }),
});
