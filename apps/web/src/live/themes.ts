// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { useReadable } from "@j3-bots/client-runtime/react";
import { useMemo } from "react";
import type { ThemesIntents, ThemesView } from "../shell/data";

/** The server's themes as the shell reads them, from the client runtime. */
export function useThemesView(j3: J3Client): ThemesView {
  const supported = useReadable(j3.themes.supported);
  const library = useReadable(j3.themes.state);
  const listed = useReadable(j3.roster)._tag === "ready";
  const value = supported && library._tag === "ready" ? library.value : null;
  const known = listed && (!supported || library._tag === "ready");
  return useMemo(() => ({ supported, library: value, known }), [supported, value, known]);
}

/** The shell's changes to the server's themes, carried out by the client runtime. */
export const themesIntents = (j3: J3Client): ThemesIntents => ({
  save: j3.themes.save,
  remove: j3.themes.remove,
  setDefault: j3.themes.setDefault,
  background: j3.themes.background,
});
