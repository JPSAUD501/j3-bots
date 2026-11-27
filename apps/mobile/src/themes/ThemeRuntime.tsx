// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ThemesClient } from "@j3-bots/client-runtime";
import { shownTheme, type ThemeChoice } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { ThemeLibrary } from "@j3-bots/contracts";
import { createContext, type ReactNode, use, useEffect, useMemo } from "react";
import { usePreferences } from "../preferences.ts";
import { showTheme } from "./look.ts";

/** The server's themes and the one this phone shows, for what offers or picks one. */
export interface ShownThemes {
  /** Whether the server keeps themes: without, only the built-ins can be shown. */
  readonly supported: boolean;
  /** The saved themes and the default; null while on its way, or where the server keeps none. */
  readonly library: ThemeLibrary | null;
  /** Whether the library is known, so a theme missing from it is gone. */
  readonly known: boolean;
  /** The theme this phone shows; null while the library it may be in is on its way. */
  readonly shown: ThemeChoice | null;
  readonly client: ThemesClient;
}

const ShownThemesContext = createContext<ShownThemes | null>(null);

/** The themes, under `ThemeRuntime`; null outside one, where nothing offers a theme. */
export const useShownThemes = (): ShownThemes | null => use(ShownThemesContext);

/**
 * Shows on this phone the theme it shows (decision 0104): the one its person
 * picked, else the server's default, and gives the themes to everything under
 * it. While the library is on its way, the app keeps the look it started with.
 */
export function ThemeRuntime({ children }: { readonly children: ReactNode }) {
  const client = useJ3Client();
  const themes = client.themes;
  const { themeId } = usePreferences();
  const supported = useReadable(themes.supported);
  const state = useReadable(themes.state);
  const listed = useReadable(client.roster)._tag === "ready";
  const library = supported && state._tag === "ready" ? state.value : null;
  const known = listed && (!supported || state._tag === "ready");
  const shown = useMemo(() => shownTheme(themeId, library, known), [themeId, library, known]);
  useEffect(() => {
    if (shown !== null) showTheme(shown);
  }, [shown]);
  const value = useMemo(
    () => ({ supported, library, known, shown, client: themes }),
    [supported, library, known, shown, themes],
  );
  return <ShownThemesContext value={value}>{children}</ShownThemesContext>;
}
