// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCookie, BrowserCookieKey, BrowserCookieSameSite } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Cookies between the DevTools protocol and the shape every host shares
// (`BrowserCookie`). Chromium marks a cookie for subdomains with a leading
// dot on its domain, and one sent to its host alone without; a cookie set
// without SameSite has none here, which must stay so, since Chromium treats
// it apart from `Lax`. Read from `Storage.getCookies`, which keeps a
// partitioned cookie's partition (decision 0110; the spike in
// `docs/architecture/browser.md`, "Sign-ins").

const CdpCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  expires: Schema.Finite,
  httpOnly: Schema.Boolean,
  secure: Schema.Boolean,
  session: Schema.Boolean,
  sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
  partitionKey: Schema.optionalKey(
    Schema.Struct({ topLevelSite: Schema.String, hasCrossSiteAncestor: Schema.Boolean }),
  ),
  /** A partition no address names, such as an opaque origin's: it cannot be set again. */
  partitionKeyOpaque: Schema.optionalKey(Schema.Boolean),
});
const decodeCdpCookie = Schema.decodeUnknownOption(CdpCookie);

const SAME_SITE_OF_CDP = {
  Strict: "strict",
  Lax: "lax",
  None: "no_restriction",
} as const satisfies Record<string, BrowserCookieSameSite>;

/**
 * A cookie as `Storage.getCookies` gives it; none for one it gives in
 * another shape, or under a partition that cannot be set again.
 */
export const cookieOfCdp = (raw: unknown): Option.Option<BrowserCookie> =>
  Option.flatMap(decodeCdpCookie(raw), (cookie) => {
    if (cookie.partitionKeyOpaque === true) return Option.none();
    const hostOnly = !cookie.domain.startsWith(".");
    const domain = hostOnly ? cookie.domain : cookie.domain.slice(1);
    if (domain.length === 0 || !cookie.path.startsWith("/")) return Option.none();
    return Option.some({
      name: cookie.name,
      value: cookie.value,
      domain,
      hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite === undefined ? "unspecified" : SAME_SITE_OF_CDP[cookie.sameSite],
      ...(cookie.session || cookie.expires < 0 ? {} : { expires: cookie.expires }),
      ...(cookie.partitionKey === undefined ? {} : { partition: cookie.partitionKey }),
    });
  });

/** `Network.CookieParam`, as `Storage.setCookies` takes it. */
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

const CDP_OF_SAME_SITE = {
  strict: "Strict",
  lax: "Lax",
  no_restriction: "None",
} as const;

/**
 * `cookie` for `Storage.setCookies`. A cookie for its host alone is set by
 * address, without a domain, which would make it one for subdomains too.
 */
export const cdpParamOf = (cookie: BrowserCookie): CdpCookieParam => ({
  name: cookie.name,
  value: cookie.value,
  ...(cookie.hostOnly
    ? { url: `${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path}` }
    : { domain: `.${cookie.domain}` }),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  ...(cookie.sameSite === "unspecified" ? {} : { sameSite: CDP_OF_SAME_SITE[cookie.sameSite] }),
  ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
  ...(cookie.partition === undefined ? {} : { partitionKey: cookie.partition }),
});

/**
 * The parameters that remove the cookie `key` names, for
 * `Storage.setCookies`: the same cookie, expired, since `Storage` removes no
 * single cookie of a browser context. Secure, so it replaces one set over
 * https or not.
 */
export const cdpRemovalOf = (key: BrowserCookieKey): CdpCookieParam => ({
  name: key.name,
  value: "",
  ...(key.hostOnly ? { url: `https://${key.domain}${key.path}` } : { domain: `.${key.domain}` }),
  path: key.path,
  secure: true,
  httpOnly: false,
  expires: 1,
  ...(key.partition === undefined ? {} : { partitionKey: key.partition }),
});
