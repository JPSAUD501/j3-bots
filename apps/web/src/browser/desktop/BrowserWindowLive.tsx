// SPDX-License-Identifier: AGPL-3.0-or-later
import { J3ClientProvider, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { use, useEffect, useMemo } from "react";
import { RosterProvider, useI18n } from "../../app/context";
import { client, server } from "../../live/client";
import type { Desktop } from "../../live/desktop";
import { themesIntents, useThemesView } from "../../live/themes";
import { ThemeRuntime } from "../../themes/ThemeRuntime";
import { BrowserProvider } from "../context";
import { DesktopBrowser } from "./DesktopBrowser";
import { useBarPresence } from "./presence/bar";
import { frontOf, tabName, useDesktopBrowser } from "./state";

/** The browser's own window, in the theme the main window shows, with who is on each tab. */
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
  const roster = useReadable(j3.roster);
  return (
    <ThemeRuntime themes={themes} intents={intents}>
      <RosterProvider roster={roster._tag === "ready" ? roster.value : []} engine={null}>
        <BrowserProvider source={j3}>
          <div className="h-dvh w-dvw">
            <WindowBrowser app={app} />
          </div>
        </BrowserProvider>
      </RosterProvider>
    </ThemeRuntime>
  );
}

function WindowBrowser({ app }: { readonly app: Desktop }) {
  const presence = useBarPresence();
  return <DesktopBrowser bridge={app.browser} place="window" presence={presence} />;
}
