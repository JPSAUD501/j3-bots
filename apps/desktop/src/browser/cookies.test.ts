// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  type BrowserCookie,
  type BrowserCookieChanges,
  BrowserHostError,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { cookieChanges, makeCookieLedger, withCookieChanges } from "./cookies.ts";

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

describe("the desktop's account of its jar", () => {
  const refused = new BrowserHostError({ reason: "page", detail: "The jar refused it." });
  /** A jar holding `cookies`, whose writes and emptying fail when `failing`. */
  const jarOf = (cookies: ReadonlyArray<BrowserCookie>) => {
    let held = cookies;
    const jar = {
      failing: false,
      read: Effect.sync(() => held),
      write: (changes: BrowserCookieChanges) =>
        Effect.suspend(() => {
          if (jar.failing) return Effect.fail(refused);
          held = [...withCookieChanges(new Map(held.map((c) => [c.name, c])), changes).values()];
          return Effect.void;
        }),
      empty: Effect.suspend(() => {
        if (jar.failing) return Effect.fail(refused);
        held = [];
        return Effect.void;
      }),
    };
    return jar;
  };

  it.effect("tells no cookie as new after an emptying that failed", () =>
    Effect.gen(function* () {
      const jar = jarOf([hostOnly]);
      const ledger = yield* makeCookieLedger(jar);
      jar.failing = true;
      const forgot = yield* Effect.exit(ledger.forget(jar.empty));
      assert.isTrue(Exit.isFailure(forgot));
      assert.deepStrictEqual(yield* ledger.look, { set: [], removed: [] });
    }),
  );

  it.effect("tells no cookie of a write that failed as removed", () =>
    Effect.gen(function* () {
      const jar = jarOf([]);
      const ledger = yield* makeCookieLedger(jar);
      jar.failing = true;
      const wrote = yield* Effect.exit(ledger.write({ set: [hostOnly], removed: [] }));
      assert.isTrue(Exit.isFailure(wrote));
      assert.deepStrictEqual(yield* ledger.look, { set: [], removed: [] });
    }),
  );
});
