// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BrowserCookie,
  BrowserCookieChanges,
  BrowserCookieKey,
  BrowserHostError,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// What a site changed in the shared sign-ins' cookies, found by comparing
// the jar with what the desktop last knew of it (decision 0110). Cookies are
// read and written with the mapping every host shares (`cookieOfCdp`,
// `cdpParamOf`, `cdpRemovalOf` in `@j3-bots/browser`).

const keyOfCookie = (cookie: BrowserCookie): BrowserCookieKey => ({
  name: cookie.name,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  path: cookie.path,
  ...(cookie.partition === undefined ? {} : { partition: cookie.partition }),
});

/** A key as a string, to index cookies by: the whole partition names one apart. */
const cookieId = (key: BrowserCookieKey): string =>
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

/** The jar the ledger keeps account of: the shared sign-ins' cookies. */
export interface CookieJar {
  readonly read: Effect.Effect<ReadonlyArray<BrowserCookie>, BrowserHostError>;
  readonly write: (changes: BrowserCookieChanges) => Effect.Effect<void, BrowserHostError>;
}

/** What the host knows of its jar, so it tells the server what the sites changed and nothing else. */
interface CookieLedger {
  /** What the jar holds that was not known, now known. */
  readonly look: Effect.Effect<BrowserCookieChanges, BrowserHostError>;
  /**
   * Writes the server's changes, known first, so their own events find
   * nothing new; a write that fails is known no more, so no look takes its
   * cookies for ones a site removed.
   */
  readonly write: (changes: BrowserCookieChanges) => Effect.Effect<void, BrowserHostError>;
  /**
   * Empties the jar with `empty`, after which nothing is known. One that
   * fails leaves what was known, so a look finds the cookies still there no
   * change, rather than tell every one of them as new.
   */
  readonly forget: (
    empty: Effect.Effect<void, BrowserHostError>,
  ) => Effect.Effect<void, BrowserHostError>;
}

/**
 * The ledger of `jar`, knowing what it holds now. Looks, writes and
 * forgetting take turns: a look between a write's being known and its
 * landing would tell its cookies as removed, then the write itself as new.
 */
export const makeCookieLedger = Effect.fn("makeCookieLedger")(function* (jar: CookieJar) {
  const turns = yield* Semaphore.make(1);
  const inTurn = turns.withPermits(1);
  let known = new Map((yield* jar.read).map((cookie) => [cookieId(keyOfCookie(cookie)), cookie]));
  const ledger: CookieLedger = {
    look: inTurn(
      Effect.gen(function* () {
        const found = cookieChanges(known, yield* jar.read);
        known = withCookieChanges(known, found);
        return found;
      }),
    ),
    write: (changes) =>
      inTurn(
        Effect.suspend(() => {
          const before = known;
          known = withCookieChanges(known, changes);
          return jar.write(changes).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                known = before;
              }),
            ),
          );
        }),
      ),
    forget: (empty) =>
      inTurn(
        Effect.tap(empty, () =>
          Effect.sync(() => {
            known = new Map();
          }),
        ),
      ),
  };
  return ledger;
});
