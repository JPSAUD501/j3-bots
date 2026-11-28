// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BrowserInternalPage,
  BrowserPlace,
  DesktopBrowserCommand,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import type { KeyWith } from "@j3-bots/i18n";
import { useI18n } from "../../../app/context";
import type { DesktopBrowserBridge } from "../../../live/desktop";

// The app's own pages, drawn in a tab in place of a site's: each part of the
// browser that has one adds it here, with the name its tab and its bar show.

/** What each of the app's pages is called, on its tab and in the window's title. */
export const PAGE_NAMES: Readonly<Record<BrowserInternalPage, KeyWith>> = {
  bookmarks: "desktopBrowser.library.bookmarks",
  history: "desktopBrowser.library.history",
};

/** What an app's page is given: the tab it is drawn in, and the browser's commands. */
export interface InternalPageProps {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab;
  readonly place: BrowserPlace;
  readonly command: (command: DesktopBrowserCommand) => void;
}

/** The app's page `page`, in the tab in front. */
export function InternalPage({ page }: InternalPageProps & { readonly page: BrowserInternalPage }) {
  const { t } = useI18n();
  switch (page) {
    case "bookmarks":
    case "history":
      return (
        <div className="flex h-full flex-col overflow-y-auto p-6">
          <h1 className="text-xl font-semibold">{t(PAGE_NAMES[page])}</h1>
        </div>
      );
  }
}

/** Names tabs as `tabName` asks: the app's pages by their names, and a new tab. */
export function usePageNamer() {
  const { t } = useI18n();
  return (page: BrowserInternalPage | null) =>
    page === null ? t("desktopBrowser.newTab") : t(PAGE_NAMES[page]);
}
