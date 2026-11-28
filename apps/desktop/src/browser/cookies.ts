// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCookie, BrowserCookieChanges, BrowserCookieKey } from "@j3-bots/contracts";

// What a site changed in the shared sign-ins' cookies, found by comparing
// the jar with what the desktop last knew of it (decision 0110). Cookies are
// read and written with the mapping every host shares (`cookieOfCdp`,
// `cdpParamOf`, `cdpRemovalOf` in `@j3-bots/browser`).

export const keyOfCookie = (cookie: BrowserCookie): BrowserCookieKey => ({
  name: cookie.name,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  path: cookie.path,
  ...(cookie.partition === undefined ? {} : { partition: cookie.partition }),
});

/** A key as a string, to index cookies by: the whole partition names one apart. */
export const cookieId = (key: BrowserCookieKey): string =>
  JSON.stringify([
    key.name,
    key.hostOnly ? key.domain : `.${key.domain}`,
    key.path,
    key.partition?.topLevelSite ?? "",
    key.partition?.hasCrossSiteAncestor ?? null,
  ]);

/** An expiry to the second: what the browser gives back for a write may differ below that. */
const expiryOf = (cookie: BrowserCookie) =>
  cookie.expires === undefined ? undefined : Math.floor(cookie.expires);

const sameCookie = (a: BrowserCookie, b: BrowserCookie) =>
  a.value === b.value &&
  a.secure === b.secure &&
  a.httpOnly === b.httpOnly &&
  a.sameSite === b.sameSite &&
  expiryOf(a) === expiryOf(b);

/**
 * What the jar now holds that `known` did not: cookies new or changed, and
 * the keys of cookies gone. Empty when nothing changed.
 */
export const cookieChanges = (
  known: ReadonlyMap<string, BrowserCookie>,
  now: ReadonlyArray<BrowserCookie>,
): BrowserCookieChanges => {
  const current = new Map(now.map((cookie) => [cookieId(keyOfCookie(cookie)), cookie]));
  const set = now.filter((cookie) => {
    const before = known.get(cookieId(keyOfCookie(cookie)));
    return before === undefined || !sameCookie(before, cookie);
  });
  const removed = [...known]
    .filter(([id]) => !current.has(id))
    .map(([, cookie]) => keyOfCookie(cookie));
  return { set, removed };
};

/** `known`, with `changes` applied: what the jar holds once they are. */
export const withCookieChanges = (
  known: ReadonlyMap<string, BrowserCookie>,
  changes: BrowserCookieChanges,
): Map<string, BrowserCookie> => {
  const next = new Map(known);
  for (const key of changes.removed) next.delete(cookieId(key));
  for (const cookie of changes.set) next.set(cookieId(keyOfCookie(cookie)), cookie);
  return next;
};
