// SPDX-License-Identifier: AGPL-3.0-or-later
import { shownTheme, type ThemeChoice, themePalettes } from "@j3-bots/client-runtime/presentation";
import type { Palette } from "@j3-bots/design-tokens";
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";
import { showLook, usePreferences } from "../preferences/preferences";
import type { ThemesIntents, ThemesView } from "../shell/data";
import { applyBackground } from "./look";
import { lookOf } from "./lookOf";

/**
 * Each picture a theme names, as a URL this page can draw, by theme and
 * revision. A picture is fetched once: a later revision is another key.
 */
const pictures = new Map<string, Promise<string | null>>();

const pictureOf = (choice: ThemeChoice, load: ThemesIntents["background"]) => {
  const background = choice.background;
  if (background === null) return Promise.resolve(null);
  const key = `${choice.id}@${background.revision}`;
  let picture = pictures.get(key);
  if (picture === undefined) {
    picture = load(choice.id, background).then((result) =>
      result._tag === "done"
        ? URL.createObjectURL(new Blob([result.value.bytes], { type: result.value.mediaType }))
        : null,
    );
    pictures.set(key, picture);
    // A picture that could not be had is asked for again next time.
    void picture.then((url) => {
      if (url === null) pictures.delete(key);
    });
  }
  return picture;
};

/** The picture of `choice` as a URL to draw, once it has arrived; null without one. */
export function useThemePicture(
  choice: ThemeChoice | null,
  load: ThemesIntents["background"],
): string | null {
  const [drawn, setDrawn] = useState<{ readonly key: string; readonly url: string | null }>({
    key: "",
    url: null,
  });
  const background = choice?.background ?? null;
  const key = choice === null || background === null ? "" : `${choice.id}@${background.revision}`;
  useEffect(() => {
    if (choice === null || key === "") return;
    let current = true;
    void pictureOf(choice, load).then((url) => {
      if (current) setDrawn({ key, url });
    });
    return () => {
      current = false;
    };
  }, [choice, key, load]);
  return drawn.key === key ? drawn.url : null;
}

/** The server's themes and the one this device shows, for what offers or picks one. */
export interface ShownThemes {
  readonly themes: ThemesView;
  readonly intents: ThemesIntents;
  /** The theme this device shows; null while the library it may be in is on its way. */
  readonly shown: ThemeChoice | null;
}

const ShownThemesContext = createContext<ShownThemes | null>(null);

/** Gives the themes to what is under it without showing any on the page, as the gallery does. */
export function ShownThemesProvider({
  value,
  children,
}: {
  readonly value: ShownThemes;
  readonly children: ReactNode;
}) {
  return <ShownThemesContext value={value}>{children}</ShownThemesContext>;
}

/** The themes, under `ThemeRuntime`; null outside one, where nothing offers a theme. */
export const useShownThemes = (): ShownThemes | null => use(ShownThemesContext);

/**
 * The colors of the theme this device shows, in `appearance`, for what draws
 * its own document, as a bot's visual or a connector's app does. Undefined,
 * the stock colors, outside a `ThemeRuntime` or while the theme is on its way.
 */
export function useShownPalette(appearance: "light" | "dark"): Palette | undefined {
  const shown = use(ShownThemesContext)?.shown ?? null;
  return shown === null ? undefined : themePalettes(shown.definition)[appearance];
}

/**
 * Shows on this page the theme this device shows (decision 0104): the one its
 * person picked, else the server's default, with its picture behind the
 * conversation, and gives it to everything under it. The look is kept, so the
 * next page starts in it. While the library is on its way, the page keeps the
 * look it started with.
 */
export function ThemeRuntime({
  themes,
  intents,
  children,
}: {
  readonly themes: ThemesView;
  readonly intents: ThemesIntents;
  readonly children: ReactNode;
}) {
  const { themeId } = usePreferences();
  const shown = useMemo(
    () => shownTheme(themeId, themes.library, themes.known),
    [themeId, themes.library, themes.known],
  );
  useEffect(() => {
    if (shown !== null) showLook(lookOf(shown, true));
  }, [shown]);
  const picture = useThemePicture(shown, intents.background);
  useEffect(() => {
    applyBackground(picture);
  }, [picture]);
  const value = useMemo(() => ({ themes, intents, shown }), [themes, intents, shown]);
  return <ShownThemesContext value={value}>{children}</ShownThemesContext>;
}
