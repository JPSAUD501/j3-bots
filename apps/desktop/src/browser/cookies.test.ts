// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { BrowserCookie } from "@j3-bots/contracts";
import { cookieChanges, withCookieChanges } from "./cookies.ts";

const hostOnly: BrowserCookie = {
  name: "sid",
  value: "1",
  domain: "app.j3test.localhost",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "unspecified",
  expires: 1_900_000_000.5,
};

describe("the changes a site makes to the desktop's cookies", () => {
  it("finds a site's changes and none of the host's own writes", () => {
    const written = withCookieChanges(new Map(), { set: [hostOnly], removed: [] });
    // What the browser gives back for the write, to the microsecond, is no change.
    assert.deepStrictEqual(
      cookieChanges(written, [{ ...hostOnly, expires: 1_900_000_000.500001 }]),
      {
        set: [],
        removed: [],
      },
    );
    const changed = { ...hostOnly, value: "2" };
    assert.deepStrictEqual(cookieChanges(written, [changed]), { set: [changed], removed: [] });
    assert.deepStrictEqual(cookieChanges(written, []), {
      set: [],
      removed: [{ name: "sid", domain: "app.j3test.localhost", hostOnly: true, path: "/" }],
    });
  });

  it("tells apart two cookies of one name under partitions that differ in their ancestry", () => {
    const partitioned = (hasCrossSiteAncestor: boolean): BrowserCookie => ({
      ...hostOnly,
      partition: { topLevelSite: "https://j3test.localhost", hasCrossSiteAncestor },
    });
    const known = withCookieChanges(new Map(), { set: [partitioned(true)], removed: [] });
    assert.deepStrictEqual(cookieChanges(known, [partitioned(true), partitioned(false)]), {
      set: [partitioned(false)],
      removed: [],
    });
  });
});
