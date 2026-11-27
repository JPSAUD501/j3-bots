// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserSuggestion } from "@j3-bots/desktop-bridge";
import type { BrowserTabRef } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// Where the browser's shared tabs went, the person's and the bots' alike, for
// the address bar's suggestions. A private tab's pages are never kept.

/** A page a shared tab went to. */
export const Visit = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(1024)),
  /** In milliseconds since the epoch. */
  at: Schema.Int,
  byBot: Schema.Boolean,
});
export type Visit = typeof Visit.Type;

/** The history as it is kept on disk: the latest visit to each address, the latest first. */
export const History = Schema.Struct({ visits: Schema.Array(Visit) });

/** How many addresses the history keeps. */
const HISTORY_SIZE = 2_000;

const TABS_SUGGESTED = 3;
const VISITS_SUGGESTED = 5;
const SITES_SUGGESTED = 8;

/** `visits` with `visit` the latest, any earlier visit to its address dropped. */
export const withVisit = (visits: ReadonlyArray<Visit>, visit: Visit): ReadonlyArray<Visit> => [
  visit,
  ...visits.filter((kept) => kept.url !== visit.url).slice(0, HISTORY_SIZE - 1),
];

/** An address as it is matched against what is typed: no scheme, no `www.`. */
const bare = (url: string) =>
  url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .toLowerCase();

/** How well `typed` matches a page: 2 when its address starts so, 1 when it holds it anywhere. */
const matchOf = (typed: string, page: { readonly url: string; readonly title: string }) => {
  const address = bare(page.url);
  if (address.startsWith(typed)) return 2;
  return address.includes(typed) || page.title.toLowerCase().includes(typed) ? 1 : 0;
};

/**
 * What the address bar suggests for `text`, best first: the open tabs that
 * match ("go to the tab"), then the addresses visited, then searching for
 * it. With nothing typed, the sites visited most, for a new tab.
 */
export const suggestionsFor = (
  text: string,
  tabs: ReadonlyArray<{
    readonly ref: BrowserTabRef;
    readonly url: string;
    readonly title: string;
  }>,
  visits: ReadonlyArray<Visit>,
): ReadonlyArray<BrowserSuggestion> => {
  const typed = text.trim().toLowerCase();
  if (typed === "") return mostVisited(visits);
  const open = tabs
    .filter((tab) => tab.url !== "" && matchOf(typed, tab) > 0)
    .toSorted((a, b) => matchOf(typed, b) - matchOf(typed, a))
    .slice(0, TABS_SUGGESTED);
  const openUrls = new Set(open.map((tab) => tab.url));
  const visited = visits
    .filter((visit) => !openUrls.has(visit.url) && matchOf(typed, visit) > 0)
    .toSorted((a, b) => matchOf(typed, b) - matchOf(typed, a) || b.at - a.at)
    .slice(0, VISITS_SUGGESTED);
  return [
    ...open.map((tab) => ({ _tag: "tab" as const, tab: tab.ref, url: tab.url, title: tab.title })),
    ...visited.map((visit) => ({ _tag: "visited" as const, ...visit })),
    { _tag: "search", text: text.trim() },
  ];
};

/** The sites visited most, each by its latest visit, the most visited first. */
const mostVisited = (visits: ReadonlyArray<Visit>): ReadonlyArray<BrowserSuggestion> => {
  const sites = new Map<string, { readonly latest: Visit; count: number }>();
  for (const visit of visits) {
    const origin = URL.parse(visit.url)?.origin;
    if (origin === undefined || origin === "null") continue;
    const site = sites.get(origin);
    if (site === undefined) sites.set(origin, { latest: visit, count: 1 });
    else site.count += 1;
  }
  return [...sites.values()]
    .toSorted((a, b) => b.count - a.count || b.latest.at - a.latest.at)
    .slice(0, SITES_SUGGESTED)
    .map(({ latest }) => ({ _tag: "visited", ...latest }));
};

/** How many visits the history shows. */
const RECENT_SHOWN = 50;

/** The latest visits, for the history. */
export const recentVisits = (visits: ReadonlyArray<Visit>): ReadonlyArray<BrowserSuggestion> =>
  visits.slice(0, RECENT_SHOWN).map((visit) => ({ _tag: "visited", ...visit }));
