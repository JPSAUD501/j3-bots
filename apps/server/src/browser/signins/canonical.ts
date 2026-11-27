// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- HMAC-SHA256 comes only from node:crypto; Effect has none.
import * as NodeCrypto from "node:crypto";
import type {
  BrowserCookie,
  BrowserCookieKey,
  BrowserOriginStorage,
  BrowserSite,
} from "@j3-bots/contracts";
import { getDomain } from "tldts";

// What the shared sign-ins compare and name things by
// (`docs/architecture/server.md`, "Sign-ins"): a cookie's key and its whole
// value, an origin's storage, a site. On disk every name is an HMAC under
// the sign-ins' key, so the file says how many cookies there are but not
// for which sites; in memory the same ids key everything, so what the file
// and a host say are compared alike.

/** An HMAC id or digest, base64url. */
export type Digest = string;

/** The site everyone signs out of with "Sign out of all sites". */
export const ALL_SITES = "*";

/**
 * The site `host` belongs to: its registrable domain by the Public Suffix
 * List, or the host itself where it has none (an address, `localhost`).
 */
export const siteOfHost = (host: string): BrowserSite => {
  const bare = host
    .replace(/^\./, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return getDomain(bare, { allowPrivateDomains: false }) ?? bare;
};

/**
 * The site of `origin`. None for an origin that is not a web address, which
 * the sign-ins never keep.
 */
export const siteOfOrigin = (origin: string): BrowserSite | undefined => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? siteOfHost(url.hostname)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The sites a cookie belongs to: its own, and the one it is partitioned under. */
export const sitesOfCookie = (cookie: BrowserCookie): ReadonlyArray<BrowserSite> => {
  const own = siteOfHost(cookie.domain);
  if (cookie.partition === undefined) return [own];
  const top = siteOfOrigin(cookie.partition.topLevelSite);
  return top === undefined || top === own ? [own] : [own, top];
};

/** The key that names `cookie`: setting a cookie of the same key replaces it. */
export const keyOfCookie = (cookie: BrowserCookie): BrowserCookieKey => ({
  name: cookie.name,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  path: cookie.path,
  ...(cookie.partition === undefined ? {} : { partition: cookie.partition.topLevelSite }),
});

/**
 * `cookie` as the sign-ins keep and compare it: a host may give an expiry
 * with a fraction of a second the next host rounds, so expiry is whole
 * seconds.
 */
export const normalCookie = (cookie: BrowserCookie): BrowserCookie =>
  cookie.expires === undefined || Number.isInteger(cookie.expires)
    ? cookie
    : { ...cookie, expires: Math.floor(cookie.expires) };

/** Whether `cookie` had expired at `now`, in milliseconds. A session cookie never has. */
export const expiredAt = (cookie: BrowserCookie, now: number) =>
  cookie.expires !== undefined && cookie.expires * 1000 <= now;

/** An origin with nothing kept. */
export const emptyStorage = (origin: string): BrowserOriginStorage => ({
  origin,
  localStorage: [],
});

export const isEmptyStorage = (storage: BrowserOriginStorage) =>
  storage.localStorage.length === 0 &&
  (storage.indexedDb === undefined || storage.indexedDb.length === 0);

/**
 * `storage` as a host that reads databases (`indexedDb`) or does not sees
 * it: the databases are compared and written only where they are kept and
 * the host reads them.
 */
export const storageView = (
  storage: BrowserOriginStorage,
  indexedDb: boolean,
): BrowserOriginStorage =>
  indexedDb
    ? { ...storage, indexedDb: storage.indexedDb ?? [] }
    : { origin: storage.origin, localStorage: storage.localStorage };

/** JSON with every object's keys in order, so equal values give equal text. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const cookieKeyText = (key: BrowserCookieKey) =>
  stableJson([key.name, key.domain, key.hostOnly, key.path, key.partition ?? null]);

const storageText = (storage: BrowserOriginStorage) =>
  stableJson({
    origin: storage.origin,
    localStorage: [...storage.localStorage].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    indexedDb: storage.indexedDb,
  });

/** The ids and digests of the sign-ins, under their key. */
export interface Digests {
  readonly cookieId: (key: BrowserCookieKey) => Digest;
  readonly cookieDigest: (cookie: BrowserCookie) => Digest;
  readonly originId: (origin: string) => Digest;
  readonly storageDigest: (storage: BrowserOriginStorage) => Digest;
  readonly siteId: (site: BrowserSite) => Digest;
  /** A host's `cookieStore`, which names its store and nothing else. */
  readonly storeId: (cookieStore: string) => Digest;
}

/** The digests under `key`, each kind of name apart from the others. */
export const makeDigests = (key: Uint8Array): Digests => {
  const mac = (kind: string, text: string) =>
    NodeCrypto.createHmac("sha256", key).update(`${kind}\0${text}`, "utf8").digest("base64url");
  return {
    cookieId: (cookieKey) => mac("cookie-key", cookieKeyText(cookieKey)),
    cookieDigest: (cookie) => mac("cookie", stableJson(normalCookie(cookie))),
    originId: (origin) => mac("origin", origin),
    storageDigest: (storage) => mac("storage", storageText(storage)),
    siteId: (site) => mac("site", site),
    storeId: (cookieStore) => mac("store", cookieStore),
  };
};
