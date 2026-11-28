// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BrowserFound,
  BrowserInternalPage,
  BrowserPlace,
  BrowserStill,
  DesktopBrowserState,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { siteOf } from "@j3-bots/client-runtime/presentation";
import { useEffect, useState } from "react";
import type { DesktopBrowserBridge } from "../../live/desktop";

// The desktop app's own browser, as a window's page follows it.

/** The browser as the app last told it; `null` until it has. */
export const useDesktopBrowser = (bridge: DesktopBrowserBridge): DesktopBrowserState | null =>
  useDesktopBrowserHere(bridge);

/** The still picture of `tab` the app sent while the page covers it. */
export function useStillOf(bridge: DesktopBrowserBridge, tab: BrowserTabRef | null) {
  const [still, setStill] = useState<BrowserStill | null>(null);
  useEffect(() => bridge.onStill(setStill), [bridge]);
  return still !== null && still.tab === tab ? still.image : null;
}

/** How finding in `tab` went, the last the app said. */
export function useFoundIn(bridge: DesktopBrowserBridge, tab: BrowserTabRef | null) {
  const [found, setFound] = useState<BrowserFound | null>(null);
  useEffect(() => bridge.onFound(setFound), [bridge]);
  return found !== null && found.tab === tab ? found : null;
}

/** The tabs `place` holds, in order. */
export const tabsIn = (state: DesktopBrowserState, place: BrowserPlace) =>
  state.tabs.filter((tab) => tab.place === place);

/** The tab in front of `place`, if any. */
export const frontOf = (state: DesktopBrowserState, place: BrowserPlace) =>
  state.tabs.find((tab) => tab.ref === state.front[place]) ?? null;

/**
 * What a tab is called: its page's title, its site, or a new tab. `named`
 * names the app's own pages, and a new tab with `null`.
 */
export const tabName = (
  tab: DesktopBrowserTab,
  named: (page: BrowserInternalPage | null) => string,
) => {
  if (tab.internal !== null) return named(tab.internal);
  return tab.title.trim() !== "" && tab.url !== "" ? tab.title : siteOf(tab.url) || named(null);
};

/** The letter that stands for a site where its icon would be. */
export const siteLetter = (url: string, title: string) =>
  (siteOf(url) || title).trim().charAt(0).toLocaleUpperCase() || "·";

/** A file's size, as a person reads it. */
export const sizeText = (bytes: number, locale: string) => {
  const [value, unit] =
    bytes >= 1_000_000
      ? [bytes / 1_000_000, "megabyte"]
      : bytes >= 1_000
        ? [bytes / 1_000, "kilobyte"]
        : [bytes, "byte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value);
};

/** The desktop app's browser, in the desktop app; `null` elsewhere, or until the app has told it. */
export function useDesktopBrowserHere(
  bridge: DesktopBrowserBridge | null,
): DesktopBrowserState | null {
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  useEffect(() => {
    if (bridge === null) return;
    let live = true;
    const stop = bridge.onChange(setState);
    void bridge.state().then((now) => {
      if (live && now !== null) setState((current) => current ?? now);
    });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  return state;
}
