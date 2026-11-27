// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCookie, BrowserCookieChanges, BrowserCookieKey } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import type { CookiesSetDetails } from "electron";

// The shared sign-ins' cookies as the desktop's browser holds them, and the
// protocol's shape of each (decision 0110). Electron's own cookie API loses
// a partitioned cookie's partition, so cookies are read with the debugger's
// `Network.getAllCookies`, which keeps it (verified on Electron 44, phase 0).

/** One cookie as CDP's `Network.getAllCookies` gives it, of the fields J3 Bots keeps. */
const CdpCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.String,
  expires: Schema.Finite,
  httpOnly: Schema.Boolean,
  secure: Schema.Boolean,
  session: Schema.Boolean,
  sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
  partitionKey: Schema.optionalKey(
    Schema.Struct({ topLevelSite: Schema.String, hasCrossSiteAncestor: Schema.Boolean }),
  ),
});
type CdpCookie = typeof CdpCookie.Type;

/** What `Network.getAllCookies` answers. */
export const AllCookies = Schema.Struct({ cookies: Schema.Array(CdpCookie) });

const SAME_SITE_FROM_CDP = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
const SAME_SITE_TO_CDP = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;

/**
 * A cookie as the protocol carries it. Its expiry is whole seconds: what
 * the desktop writes and reads back then compares equal, so a write is
 * never mistaken for a site's change.
 */
export const cookieFromCdp = (cookie: CdpCookie): BrowserCookie => {
  const hostOnly = !cookie.domain.startsWith(".");
  return {
    name: cookie.name,
    value: cookie.value,
    domain: hostOnly ? cookie.domain : cookie.domain.slice(1),
    hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === undefined ? "unspecified" : SAME_SITE_FROM_CDP[cookie.sameSite],
    ...(cookie.session ? {} : { expires: Math.floor(cookie.expires) }),
    ...(cookie.partitionKey === undefined ? {} : { partition: cookie.partitionKey }),
  };
};

/** `cookie` as the desktop keeps it: what reading it back would give. */
const asKept = (cookie: BrowserCookie): BrowserCookie =>
  cookie.expires === undefined ? cookie : { ...cookie, expires: Math.floor(cookie.expires) };

/** An address the cookie is sent to, which is what both of Electron's APIs place it by. */
const addressOf = (cookie: BrowserCookie) =>
  `${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path}`;

/**
 * For `session.cookies.set`. A host-only cookie is given no domain: Electron
 * widens any domain it is given to the subdomains.
 */
export const toElectronCookie = (cookie: BrowserCookie): CookiesSetDetails => ({
  url: addressOf(cookie),
  name: cookie.name,
  value: cookie.value,
  ...(cookie.hostOnly ? {} : { domain: `.${cookie.domain}` }),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  ...(cookie.expires === undefined ? {} : { expirationDate: cookie.expires }),
});

/**
 * For `Network.setCookies`, for a partitioned cookie, which Electron's API
 * cannot write: an address makes a host-only cookie, a domain one with a
 * leading dot a domain cookie, and no `sameSite` leaves it unspecified.
 */
export const toCdpCookie = (cookie: BrowserCookie) => ({
  name: cookie.name,
  value: cookie.value,
  ...(cookie.hostOnly ? { url: addressOf(cookie) } : { domain: `.${cookie.domain}` }),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  ...(cookie.sameSite === "unspecified" ? {} : { sameSite: SAME_SITE_TO_CDP[cookie.sameSite] }),
  ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
  ...(cookie.partition === undefined ? {} : { partitionKey: cookie.partition }),
});

/**
 * For `Network.deleteCookies`, each call of it that removes exactly the
 * cookie of that domain, path and partition: Electron's `cookies.remove`
 * takes an address, which a domain cookie of the same name also matches.
 * A partition is named by its site and whether a cross-site frame set it,
 * and a key carries only the site, so a partitioned cookie takes both.
 */
export const toCdpRemovals = (key: BrowserCookieKey) => {
  const named = {
    name: key.name,
    domain: key.hostOnly ? key.domain : `.${key.domain}`,
    path: key.path,
  };
  const { partition } = key;
  return partition === undefined
    ? [named]
    : [true, false].map((hasCrossSiteAncestor) => ({
        ...named,
        partitionKey: { topLevelSite: partition, hasCrossSiteAncestor },
      }));
};

export const keyOfCookie = (cookie: BrowserCookie): BrowserCookieKey => ({
  name: cookie.name,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  path: cookie.path,
  ...(cookie.partition === undefined ? {} : { partition: cookie.partition.topLevelSite }),
});

/** A key as a string, to index cookies by. */
export const cookieId = (key: BrowserCookieKey): string =>
  JSON.stringify([
    key.name,
    key.hostOnly ? key.domain : `.${key.domain}`,
    key.path,
    key.partition ?? "",
  ]);

const sameCookie = (a: BrowserCookie, b: BrowserCookie) =>
  a.value === b.value &&
  a.secure === b.secure &&
  a.httpOnly === b.httpOnly &&
  a.sameSite === b.sameSite &&
  a.expires === b.expires &&
  a.partition?.hasCrossSiteAncestor === b.partition?.hasCrossSiteAncestor;

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
  for (const cookie of changes.set) next.set(cookieId(keyOfCookie(cookie)), asKept(cookie));
  return next;
};
