// SPDX-License-Identifier: AGPL-3.0-or-later
import { J3ClientProvider, useJ3Client } from "@j3-bots/client-runtime/react";
import { use, useEffect, useMemo } from "react";
import { useI18n } from "../../app/context";
import { client, server } from "../../live/client";
import type { Desktop } from "../../live/desktop";
import { themesIntents, useThemesView } from "../../live/themes";
import { ThemeRuntime } from "../../themes/ThemeRuntime";
import { DesktopBrowser } from "./DesktopBrowser";
import { frontOf, tabName, useDesktopBrowser } from "./state";

/** The browser's own window, in the theme the main window shows. */
export function BrowserWindowLive({ app }: { readonly app: Desktop }) {
  if (server === null) return null;
  return (
    <J3ClientProvider client={use(client(server))}>
      <Themed app={app} />
    </J3ClientProvider>
  );
}

function Themed({ app }: { readonly app: Desktop }) {
  const j3 = useJ3Client();
  const themes = useThemesView(j3);
  const intents = useMemo(() => themesIntents(j3), [j3]);
  const { t } = useI18n();
  const state = useDesktopBrowser(app.browser);
  // The window is named by its tab in front, as a browser's is.
  const front = state === null ? null : frontOf(state, "window");
  const title = front === null ? "J3 Bots" : tabName(front, t("desktopBrowser.newTab"));
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <ThemeRuntime themes={themes} intents={intents}>
      <div className="h-dvh w-dvw">
        <DesktopBrowser bridge={app.browser} place="window" />
      </div>
    </ThemeRuntime>
  );
}
