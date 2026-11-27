// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { BrowserCookie } from "@j3-bots/contracts";
import {
  cookieChanges,
  cookieFromCdp,
  toCdpCookie,
  toCdpRemovals,
  toElectronCookie,
  withCookieChanges,
} from "./cookies.ts";

const cdp = {
  name: "sid",
  value: "1",
  path: "/",
  expires: 1_900_000_000.75,
  httpOnly: true,
  secure: true,
  session: false,
};

const hostOnly: BrowserCookie = {
  name: "sid",
  value: "1",
  domain: "app.j3test.localhost",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "unspecified",
  expires: 1_900_000_000,
};

describe("cookies of the desktop's browser", () => {
  it("reads host-only and domain cookies apart, and one set without SameSite as unspecified", () => {
    assert.deepStrictEqual(cookieFromCdp({ ...cdp, domain: "app.j3test.localhost" }), hostOnly);
    assert.deepStrictEqual(
      cookieFromCdp({ ...cdp, domain: ".j3test.localhost", sameSite: "None", session: true }),
      {
        name: "sid",
        value: "1",
        domain: "j3test.localhost",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
      },
    );
  });

  it("writes a host-only cookie without a domain, which Electron would widen", () => {
    assert.notProperty(toElectronCookie(hostOnly), "domain");
    assert.strictEqual(
      toElectronCookie({ ...hostOnly, hostOnly: false }).domain,
      ".app.j3test.localhost",
    );
    assert.notProperty(toCdpCookie(hostOnly), "sameSite");
  });

  it("removes a partitioned cookie under either kind of partition", () => {
    const key = {
      name: "p",
      domain: "w.j3test.localhost",
      hostOnly: true,
      path: "/",
      partition: "https://j3test.localhost",
    };
    assert.deepStrictEqual(
      toCdpRemovals(key),
      [true, false].map((hasCrossSiteAncestor) => ({
        name: "p",
        domain: "w.j3test.localhost",
        path: "/",
        partitionKey: { topLevelSite: "https://j3test.localhost", hasCrossSiteAncestor },
      })),
    );
  });

  it("finds a site's changes and none of the host's own writes", () => {
    const written = withCookieChanges(new Map(), {
      set: [{ ...hostOnly, expires: 1_900_000_000.5 }],
      removed: [],
    });
    // What the browser gives back for the write is no change.
    assert.deepStrictEqual(
      cookieChanges(written, [cookieFromCdp({ ...cdp, domain: "app.j3test.localhost" })]),
      { set: [], removed: [] },
    );
    const changed = { ...hostOnly, value: "2" };
    assert.deepStrictEqual(cookieChanges(written, [changed]), { set: [changed], removed: [] });
    assert.deepStrictEqual(cookieChanges(written, []), {
      set: [],
      removed: [{ name: "sid", domain: "app.j3test.localhost", hostOnly: true, path: "/" }],
    });
  });
});
