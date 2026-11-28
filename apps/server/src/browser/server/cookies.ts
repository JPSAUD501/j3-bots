// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCookie, BrowserCookieKey } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

// Cookies between the shared shape (`BrowserCookie`) and Chromium's own, as
// the raw CDP `Storage.*` methods read and write them for one browser
// context. Never Playwright's cookie calls: they turn a cookie set without
// SameSite into `Lax` (**Verified** in the 0.16 browser spike).

const CdpSameSite = Schema.Literals(["Strict", "Lax", "None"]);

/** A cookie as CDP's `Storage.getCookies` gives it, the fields read. */
export const CdpCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  /** Unix seconds; -1 or absent for a session cookie. */
  expires: Schema.optionalKey(Schema.Finite),
  httpOnly: Schema.Boolean,
  secure: Schema.Boolean,
  session: Schema.optionalKey(Schema.Boolean),
  sameSite: Schema.optionalKey(CdpSameSite),
  partitionKey: Schema.optionalKey(
    Schema.Struct({ topLevelSite: Schema.String, hasCrossSiteAncestor: Schema.Boolean }),
  ),
});
export type CdpCookie = typeof CdpCookie.Type;

export const CdpCookies = Schema.Struct({ cookies: Schema.Array(CdpCookie) });

/** A cookie as CDP's `Storage.setCookies` takes it. */
export interface CdpCookieParam {
  readonly name: string;
  readonly value: string;
  readonly url?: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly expires?: number;
  readonly partitionKey?: { readonly topLevelSite: string; readonly hasCrossSiteAncestor: boolean };
}

const SAME_SITE_IN = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
const SAME_SITE_OUT = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;

export const fromCdp = (cookie: CdpCookie): BrowserCookie => {
  const hostOnly = !cookie.domain.startsWith(".");
  const session = cookie.session === true || cookie.expires === undefined || cookie.expires < 0;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: hostOnly ? cookie.domain : cookie.domain.slice(1),
    hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === undefined ? "unspecified" : SAME_SITE_IN[cookie.sameSite],
    ...(session || cookie.expires === undefined ? {} : { expires: cookie.expires }),
    ...(cookie.partitionKey === undefined ? {} : { partition: cookie.partitionKey }),
  };
};

/**
 * The parameters that set `cookie`. A host-only cookie is named by an
 * address, since a domain, even without its dot, would widen it to the
 * subdomains; a domain cookie by its domain with a leading dot.
 */
export const toCdp = (cookie: BrowserCookie): CdpCookieParam => ({
  name: cookie.name,
  value: cookie.value,
  ...(cookie.hostOnly
    ? { url: `${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path}` }
    : { domain: `.${cookie.domain}` }),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  ...(cookie.sameSite === "unspecified" ? {} : { sameSite: SAME_SITE_OUT[cookie.sameSite] }),
  ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
  ...(cookie.partition === undefined ? {} : { partitionKey: cookie.partition }),
});

/**
 * The parameters that remove the cookie `key` names: the same cookie,
 * expired. `Storage` has no call that removes one cookie of a context.
 */
export const removalOf = (key: BrowserCookieKey): CdpCookieParam => ({
  name: key.name,
  value: "",
  ...(key.hostOnly ? { url: `https://${key.domain}${key.path}` } : { domain: `.${key.domain}` }),
  path: key.path,
  secure: key.hostOnly,
  httpOnly: false,
  expires: 1,
  ...(key.partition === undefined
    ? {}
    : { partitionKey: { topLevelSite: key.partition, hasCrossSiteAncestor: false } }),
});
