// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserTabRef } from "@j3-bots/contracts";
import type {
  BrowserFound,
  BrowserStill,
  BrowserSuggestion,
  DesktopBrowserCommand,
  DesktopBrowserState,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import type { DesktopBrowserBridge } from "../live/desktop";

// The desktop app's own browser, played in memory for the gallery: tabs,
// downloads and finding answer as the app would, and the page in front is a
// drawing of an invented site, since a page itself is the app's view and
// never part of the window's page.

export const sampleTabRef = (name: string) => BrowserTabRef.make(`tab_desktop_${name}`);

export const sampleDesktopTab = (
  name: string,
  change: Partial<DesktopBrowserTab> = {},
): DesktopBrowserTab => ({
  ref: sampleTabRef(name),
  url: "https://bakery.example/orders",
  title: "Orders · Corner Bakery",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoom: 100,
  private: false,
  held: false,
  place: "panel",
  failed: null,
  internal: null,
  ...change,
});

/** An invented site, drawn: what the page in front shows in the gallery. */
const PAGE_DRAWING = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
  <rect width="960" height="640" fill="#fbf7f1"/>
  <rect width="960" height="64" fill="#7a3b1d"/>
  <text x="32" y="40" font-family="Georgia, serif" font-size="22" fill="#fff">Corner Bakery</text>
  <text x="620" y="40" font-family="sans-serif" font-size="14" fill="#f3dcc8">Menu   Orders   Contact</text>
  <text x="32" y="124" font-family="Georgia, serif" font-size="30" fill="#3b2314">Orders for Saturday</text>
  <text x="32" y="154" font-family="sans-serif" font-size="15" fill="#6d5443">Pick up from 7 am</text>
  ${[0, 1, 2]
    .map(
      (
        i,
      ) => `<rect x="${32 + i * 300}" y="190" width="276" height="220" rx="12" fill="#fff" stroke="#ead9c8"/>
  <rect x="${48 + i * 300}" y="206" width="244" height="120" rx="8" fill="#f1e2d0"/>
  <text x="${48 + i * 300}" y="356" font-family="sans-serif" font-size="16" fill="#3b2314">${["Cheese bread", "Cream doughnut", "Corn cake"][i]}</text>
  <text x="${48 + i * 300}" y="382" font-family="sans-serif" font-size="14" fill="#6d5443">${["$2.50", "$6.00", "$28.00"][i]}</text>`,
    )
    .join("")}
  <rect x="32" y="440" width="896" height="72" rx="12" fill="#fff" stroke="#ead9c8"/>
  <text x="56" y="482" font-family="sans-serif" font-size="16" fill="#3b2314">Cheese bread</text>
  <rect x="300" y="458" width="80" height="36" rx="6" fill="#fbf7f1" stroke="#d8c3ae"/>
  <text x="326" y="482" font-family="sans-serif" font-size="16" fill="#3b2314">40</text>
  <rect x="720" y="456" width="184" height="40" rx="20" fill="#7a3b1d"/>
  <text x="752" y="482" font-family="sans-serif" font-size="15" fill="#fff">Add to order</text>
</svg>`,
)}`;

const SITES: ReadonlyArray<BrowserSuggestion> = [
  { _tag: "visited", url: "https://bakery.example/", title: "Corner Bakery", byBot: false, at: 0 },
  {
    _tag: "visited",
    url: "https://news.example/",
    title: "Neighborhood News",
    byBot: false,
    at: 0,
  },
  { _tag: "visited", url: "https://mail.example/", title: "Mail", byBot: false, at: 0 },
  { _tag: "visited", url: "https://tickets.example/", title: "City Tickets", byBot: true, at: 0 },
];

/** The browser `first` is, answering what the page asks of it. */
export function sampleDesktopBrowser(first: DesktopBrowserState): DesktopBrowserBridge {
  let state = first;
  const changed = new Set<(state: DesktopBrowserState) => void>();
  const found = new Set<(found: BrowserFound) => void>();
  const stills = new Set<(still: BrowserStill) => void>();
  // The page in front of every place, drawn.
  const draw = (listener: (still: BrowserStill) => void) => {
    for (const ref of [state.front.panel, state.front.window]) {
      if (ref !== null) listener({ tab: ref, image: PAGE_DRAWING });
    }
  };
  const set = (next: DesktopBrowserState) => {
    state = next;
    for (const listener of changed) listener(state);
    for (const listener of stills) draw(listener);
  };
  const onTab = (ref: BrowserTabRef, change: (tab: DesktopBrowserTab) => DesktopBrowserTab) =>
    set({ ...state, tabs: state.tabs.map((tab) => (tab.ref === ref ? change(tab) : tab)) });
  let opened = 0;
  const command = (asked: DesktopBrowserCommand) => {
    switch (asked._tag) {
      case "open": {
        opened += 1;
        const tab = sampleDesktopTab(`opened_${opened}`, {
          url: "",
          title: "",
          canGoBack: false,
          private: asked.private,
          place: asked.place,
        });
        set({
          ...state,
          tabs: [...state.tabs, tab],
          front: { ...state.front, [asked.place]: tab.ref },
        });
        return;
      }
      case "close": {
        const tabs = state.tabs.filter((tab) => tab.ref !== asked.tab);
        const frontOf = (ref: BrowserTabRef | null) =>
          ref === asked.tab ? (tabs.at(-1)?.ref ?? null) : ref;
        set({
          ...state,
          tabs,
          front: { panel: frontOf(state.front.panel), window: frontOf(state.front.window) },
          canReopen: true,
        });
        return;
      }
      case "show":
        onTab(asked.tab, (tab) => ({ ...tab, place: asked.place }));
        set({ ...state, front: { ...state.front, [asked.place]: asked.tab } });
        return;
      case "zoom":
        onTab(asked.tab, (tab) => ({
          ...tab,
          zoom:
            asked.to === "reset"
              ? 100
              : Math.min(500, Math.max(25, tab.zoom + (asked.to === "in" ? 10 : -10))),
        }));
        return;
      case "find":
        for (const listener of found) listener({ tab: asked.tab, active: 1, matches: 3 });
        return;
      case "go":
        onTab(asked.tab, (tab) => ({
          ...tab,
          url: "https://bakery.example/",
          title: "Corner Bakery",
        }));
        return;
      default:
        return;
    }
  };
  return {
    link: () => {},
    state: () => Promise.resolve(state),
    onChange: (listener) => {
      changed.add(listener);
      listener(state);
      return () => changed.delete(listener);
    },
    command,
    place: () => {},
    onStill: (listener) => {
      stills.add(listener);
      draw(listener);
      return () => stills.delete(listener);
    },
    onFound: (listener) => {
      found.add(listener);
      return () => found.delete(listener);
    },
    onShortcut: () => () => {},
    suggest: (text) =>
      Promise.resolve(
        text === ""
          ? SITES
          : [
              ...SITES.filter(
                (site) => site._tag === "visited" && site.url.includes(text.toLowerCase()),
              ),
              { _tag: "search", text },
            ],
      ),
    // The gallery draws no page: who is on a tab shows only around it.
    presence: () => {},
  };
}
