// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserCookie,
  type BrowserCookieChanges,
  type BrowserHostError,
  type BrowserHostEvent,
  type BrowserHostHello,
  type BrowserOriginStorage,
  type BrowserSignIns,
  type BrowserSite,
  type BrowserTabRef,
  Conflict,
} from "@j3-bots/contracts";
import type { PageHost, PageHostPayload } from "@j3-bots/browser";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Layout } from "../../Layout.ts";
import { Secrets } from "../../secrets/Secrets.ts";
import {
  ALL_SITES,
  type Digest,
  type Digests,
  emptyStorage,
  expiredAt,
  isEmptyStorage,
  keyOfCookie,
  makeDigests,
  siteOfHost,
  siteOfOrigin,
  sitesOfCookie,
  storageView,
} from "./canonical.ts";
import {
  type JarCommit,
  type JarContents,
  type JarFile,
  KEPT_MS,
  type OpenedJar,
  openJarFile,
  SIGNINS_FILE,
  type StoreBaseline,
} from "./JarFile.ts";
import {
  databaseBytes,
  diffHostCookies,
  hasCookieChanges,
  type JarCookieChanges,
  type JarOrigin,
  reconcileCookies,
  reconcileOrigin,
  takeHostCookies,
  UNKNOWN,
} from "./merge.ts";

// The shared sign-ins of J3 Bots' browser (decision 0110;
// `docs/architecture/server.md`, "Sign-ins"): one jar of cookies and site
// storage on the server, which every host's store agrees with. A host
// attaches with its hello; its cookies are reconciled with the jar before
// `attach` returns, and its sites' storage after, in the background, the
// origin a tab is about to open first (`prepare`). While it is attached,
// what its sites change goes to the jar and from there to every other host:
// as the host reports it (`changeEvents`), or as the server reads it again
// after a page loads, when a tab closes, every minute while a tab is open,
// and before the host closes (`flush`).
//
// One change at a time: the jar and the hosts' writes go through one lock,
// so two hosts' changes are never interleaved, and each change runs to its
// end in the sign-ins' own scope, whoever asked for it and whether or not
// they still wait. A host a call to fails is synced no more until it is
// reconciled again, a little later, as when it attaches.

/** How long one host call of the sync may take. */
const HOST_CALL_MS = 15_000;
/** How long `prepare` waits for an origin's storage before the tab opens anyway. */
const PREPARE_MS = 5_000;
/** How often a host without change events is read while it has a tab open. */
const READ_EVERY = "60 seconds";
/** How long a page load waits before the read it asks for, so loads in a row read once. */
const READ_AFTER_LOAD_MS = 1_000;
/**
 * How long after a sign-out a host's report of a change to a site signed
 * out of is checked against what the host holds: a report the host sent
 * before it took the sign-out may arrive after it.
 */
const FENCE_MS = 10_000;
/** How long a host a call failed to waits before it is reconciled again, by failures in a row. */
const RETRY_MS = [5_000, 30_000, 120_000, 600_000] as const;
/** The longest wait for the next cookie to expire before the list is drawn again. */
const EXPIRY_CHECK_MS = 24 * 60 * 60 * 1000;

/** How much of sites' IndexedDB the jar carries between browsers, encoded. */
export interface DatabaseLimits {
  /** The most one origin's databases may take. */
  readonly origin: number;
  /** The most every origin's databases may take together. */
  readonly total: number;
}

const MIB = 1024 * 1024;
export const DATABASE_LIMITS: DatabaseLimits = { origin: 5 * MIB, total: 64 * MIB };

/** What the sync of one attached host takes from its owner. */
export interface SignInsAttachment {
  /** An event the host sent, as it came, private tabs' included. */
  readonly event: (event: BrowserHostEvent) => Effect.Effect<void>;
  /** Reads a host without change events once more: before it closes. */
  readonly flush: Effect.Effect<void>;
  /**
   * Puts `url`'s origin's storage on the host first, before a tab opens
   * there; it waits a few seconds at most, and never fails.
   */
  readonly prepare: (url: string) => Effect.Effect<void>;
}

export class SignIns extends Context.Service<
  SignIns,
  {
    /** Syncs `host` with the jar until the scope closes. */
    readonly attach: (
      host: PageHost,
      hello: BrowserHostHello,
    ) => Effect.Effect<SignInsAttachment, never, Scope.Scope>;
    /** The sites signed in to, now and on every change. */
    readonly view: Stream.Stream<BrowserSignIns>;
    /** Signs out of `site` on every host: at once on those attached, first thing on others. */
    readonly signOutSite: (site: BrowserSite) => Effect.Effect<void>;
    /**
     * Signs out of every site. On a jar that is unreadable, it starts the
     * jar again, empty. `Conflict("secrets-unavailable")` when the secrets
     * cannot be read, and so neither can the jar be sealed.
     */
    readonly signOut: Effect.Effect<void, Conflict>;
    /**
     * Whether the sign-ins of before 0.16 are still to be brought in (`due`),
     * were (`done`), or cannot be now, since the jar cannot be read.
     */
    readonly toBringIn: Effect.Effect<"due" | "done" | "unavailable">;
    /**
     * Brings in the sign-ins of before 0.16, once: what the jar does not
     * hold is added, nothing it holds is replaced, and nothing of a site
     * signed out of since is.
     */
    readonly bringIn: (input: {
      readonly cookies: ReadonlyArray<BrowserCookie>;
      /** Each origin's storage, with every database it kept. */
      readonly origins: ReadonlyArray<BrowserOriginStorage>;
      /** The sites the old browser showed as pages. */
      readonly sites: ReadonlyArray<BrowserSite>;
    }) => Effect.Effect<void>;
  }
>()("@j3-bots/server/browser/signins/SignIns") {}

/** The jar open: what it holds, its file, and the names under its key. */
interface Open {
  readonly contents: MutableContents;
  readonly file: JarFile;
  readonly digests: Digests;
}

/** The jar now: open, unreadable with a file that can start again, or without a key at all. */
type Jar =
  | ({ readonly _tag: "open" } & Open)
  | {
      readonly _tag: "unreadable";
      readonly reset: Extract<OpenedJar, { _tag: "unreadable" }>["reset"];
      readonly digests: Digests;
    }
  | { readonly _tag: "keyless" };

interface MutableContents extends Omit<JarContents, "version" | "migrated" | "clearedAt"> {
  version: number;
  migrated: boolean;
  clearedAt: number | undefined;
}

/** One attached host and what the sync knows of it. */
interface Attached {
  readonly host: PageHost;
  /** The attachment's scope, where its background work runs. */
  readonly scope: Scope.Scope;
  /** Its store's id, when it keeps one across starts. */
  readonly store: Digest | undefined;
  /** The run of its browser, when it names one. */
  readonly run: Digest | undefined;
  readonly cookies: boolean;
  readonly storage: boolean;
  readonly indexedDb: boolean;
  readonly events: boolean;
  /** What it holds as of its last agreement with the jar; none until it is first reconciled. */
  baseline:
    | { readonly cookies: Map<Digest, Digest>; readonly origins: Map<Digest, Digest> }
    | undefined;
  /** The version up to which every sign-out reached it: a sign-out after wins over its changes. */
  since: number;
  /** The version its last reconcile agreed at, which `since` moves to once its origins are done. */
  agreeing: number;
  /** The latest sign-out that reached it while its origins were still being reconciled. */
  signedOut: number;
  /** Whether every origin it was reconciled with is done since. */
  agreed: boolean;
  /** Origins whose storage is still to be reconciled. */
  readonly pending: Set<Digest>;
  /**
   * Origins it wrote nothing of, as a page of them may hold their databases
   * open, and how often in a row: each is tried again on its own.
   */
  readonly waiting: Map<Digest, { tries: number; retrying: boolean }>;
  /** Its tabs, and whether each is private: only shared tabs' pages are read. */
  readonly tabs: Map<BrowserTabRef, { url: string; readonly private: boolean }>;
  /** Origins a tab left or closed on: a host without change events reads them once more. */
  readonly touched: Set<string>;
  /** Origins its shared tabs showed while attached: a sign-out of their site clears them too. */
  readonly seen: Set<string>;
  /** Sites signed out of lately, or every site, and until when its reports of them are checked. */
  readonly fences: Map<BrowserSite, number>;
  /**
   * Cookies the server wrote to it lately, and until when its reports of
   * them are checked: a report it made before the write, delivered after,
   * would take back what it no longer holds.
   */
  readonly written: Map<Digest, number>;
  /** A call to it failed: it is synced no more until it is reconciled again. */
  broken: boolean;
  /** Whether it is to be reconciled again, after a wait. */
  retrying: boolean;
  /** Failures in a row, which the wait grows with. */
  failures: number;
}

/** An address's origin, for http and https alone. */
const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The changes other hosts take for what the jar took, read before the jar takes it. */
const forOthers = (contents: MutableContents, changes: JarCookieChanges): BrowserCookieChanges => ({
  set: changes.set.map(([, cookie]) => cookie),
  removed: changes.removed.flatMap(([id]) => {
    const kept = contents.cookies.get(id);
    return kept === undefined ? [] : [keyOfCookie(kept)];
  }),
});

const sameView = (a: BrowserSignIns, b: BrowserSignIns) =>
  a.status === b.status &&
  a.sites.length === b.sites.length &&
  a.sites.every(
    ({ site, tooBig }, at) => b.sites[at]?.site === site && b.sites[at]?.tooBig === tooBig,
  );

/** The sites a reported change to cookies touches. */
const sitesOfChanges = (changes: BrowserCookieChanges): ReadonlyArray<BrowserSite> => [
  ...changes.set.flatMap(sitesOfCookie),
  ...changes.removed.map((key) => siteOfHost(key.domain)),
];

/**
 * An origin emptied, as the jar keeps it after a sign-out, which deletes
 * its databases on every host too: none, and none too big.
 */
const emptied = (origin: JarOrigin): JarOrigin => ({
  storage: { ...emptyStorage(origin.storage.origin), indexedDb: [] },
});

/**
 * The sign-ins over `opened`, the jar as it opened under the key `digests`
 * names by, until the scope closes. None: the secrets had no key to open it
 * with.
 */
export const makeSignIns = Effect.fn("SignIns.make")(function* (
  opened: { readonly jar: OpenedJar; readonly digests: Digests } | undefined,
  limits: DatabaseLimits = DATABASE_LIMITS,
) {
  const scope = yield* Effect.scope;
  let jar: Jar =
    opened === undefined
      ? { _tag: "keyless" }
      : opened.jar._tag === "open"
        ? {
            _tag: "open",
            file: opened.jar.file,
            digests: opened.digests,
            contents: { ...opened.jar.contents },
          }
        : { _tag: "unreadable", reset: opened.jar.reset, digests: opened.digests };
  const lock = Semaphore.makeUnsafe(1);
  /**
   * Runs `effect` under the lock in the sign-ins' scope, to its end: the
   * caller waits for it, but stopping the caller does not stop it.
   */
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.flatMap(Effect.forkIn(lock.withPermit(effect), scope), Fiber.join);
  const attached = new Set<Attached>();
  /** The jar when it is open, for a change; a change on a jar that is not does nothing. */
  const openJar = (): Open | undefined => (jar._tag === "open" ? jar : undefined);

  /** What each origin's databases take in the jar, and all of them together. */
  const databaseSizes = new Map<Digest, number>();
  let databaseTotal = 0;
  const countDatabases = (id: Digest, origin: JarOrigin) => {
    const bytes = databaseBytes(origin.storage.indexedDb);
    databaseTotal += bytes - (databaseSizes.get(id) ?? 0);
    if (bytes === 0) databaseSizes.delete(id);
    else databaseSizes.set(id, bytes);
  };
  const countAll = () => {
    databaseSizes.clear();
    databaseTotal = 0;
    if (jar._tag === "open")
      for (const [id, origin] of jar.contents.origins) countDatabases(id, origin);
  };
  countAll();
  /** How many bytes origin `id`'s databases may take, besides every other origin's. */
  const roomFor = (id: Digest) =>
    Math.min(limits.origin, limits.total - (databaseTotal - (databaseSizes.get(id) ?? 0)));

  /** The sites that hold something, and the earliest a cookie of them expires. */
  const viewOf = (now: number): { view: BrowserSignIns; expires: number | undefined } => {
    if (jar._tag === "keyless")
      return { view: { status: "locked", sites: [] }, expires: undefined };
    if (jar._tag === "unreadable")
      return { view: { status: "unreadable", sites: [] }, expires: undefined };
    const holding = new Set<BrowserSite>();
    const tooBig = new Set<BrowserSite>();
    let expires: number | undefined;
    for (const cookie of jar.contents.cookies.values()) {
      if (expiredAt(cookie, now)) continue;
      for (const site of sitesOfCookie(cookie)) holding.add(site);
      if (cookie.expires !== undefined)
        expires = Math.min(expires ?? Number.POSITIVE_INFINITY, cookie.expires * 1000);
    }
    for (const origin of jar.contents.origins.values()) {
      const site = siteOfOrigin(origin.storage.origin);
      if (site === undefined) continue;
      // An origin too big to carry still holds a sign-in, in each browser.
      if (origin.tooBig === true) tooBig.add(site);
      if (origin.tooBig === true || !isEmptyStorage(origin.storage)) holding.add(site);
    }
    const sites = [...jar.contents.sites.values()].filter((site) => holding.has(site)).sort();
    return {
      view: {
        status: "ready",
        sites: sites.map((site) => (tooBig.has(site) ? { site, tooBig: true } : { site })),
      },
      expires,
    };
  };
  const first = viewOf(yield* Clock.currentTimeMillis);
  const view = yield* SubscriptionRef.make(first.view);
  /** When the list is to be drawn again for a cookie that expires, short of a change. */
  let expires = first.expires;
  const redrawn = yield* Queue.sliding<void>(1);
  /** Draws the list again: on every change, and when a cookie in it expires. */
  const publish = Effect.gen(function* () {
    const next = viewOf(yield* Clock.currentTimeMillis);
    expires = next.expires;
    if (!sameView(yield* SubscriptionRef.get(view), next.view))
      yield* SubscriptionRef.set(view, next.view);
    yield* Queue.offer(redrawn, undefined);
  });
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const wait = Math.min(EXPIRY_CHECK_MS, Math.max(0, (expires ?? Infinity) - now));
        yield* Queue.take(redrawn).pipe(
          Effect.timeoutOrElse({ duration: wait, orElse: () => publish }),
        );
      }),
    ),
    scope,
  );

  /** A call to a host; its failure is logged, by what failed alone, and answers none. */
  const hostCall = <A>(what: string, call: Effect.Effect<A, BrowserHostError>) =>
    call.pipe(
      Effect.timeout(HOST_CALL_MS),
      Effect.asSome,
      Effect.catch((error: BrowserHostError | Cause.TimeoutError) =>
        Effect.logWarning(`A browser host did not ${what}`).pipe(
          Effect.annotateLogs({
            reason: error._tag === "BrowserHostError" ? error.reason : "timeout",
          }),
          Effect.as(Option.none<A>()),
        ),
      ),
    );

  /** Host `a`'s baseline as the file keeps it, whole. */
  const saveBaseline = (open: Open, a: Attached) =>
    a.store === undefined || a.baseline === undefined
      ? Effect.void
      : open.file.commit({
          version: open.contents.version,
          stores: [
            {
              id: a.store,
              version: a.since,
              run: a.run,
              replace: true,
              cookies: a.baseline.cookies,
              origins: a.baseline.origins,
            },
          ],
        });

  /**
   * A host a call to failed: synced no more, its baseline kept as it was,
   * until it is reconciled again after a wait.
   */
  const broke = (a: Attached): Effect.Effect<void> =>
    Effect.suspend(() => {
      a.broken = true;
      a.agreed = false;
      if (a.retrying) return Effect.void;
      a.retrying = true;
      a.failures += 1;
      const wait = RETRY_MS[Math.min(a.failures, RETRY_MS.length) - 1] ?? RETRY_MS[0];
      return Effect.forkIn(
        Effect.sleep(wait).pipe(
          Effect.andThen(
            run(
              Effect.suspend(() => {
                a.retrying = false;
                return attached.has(a) ? reconcile(a) : Effect.void;
              }),
            ),
          ),
        ),
        a.scope,
      ).pipe(Effect.asVoid);
    });

  /**
   * Writes a change to the jar and the file; the jar's version moves on
   * when the change holds anything. It is not stopped halfway: the jar in
   * memory and the file agree after it.
   */
  const change = (open: Open, input: Omit<JarCommit, "version">) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const { contents, file } = open;
        const moves =
          (input.cookies?.set.length ?? 0) +
            (input.cookies?.removed.length ?? 0) +
            (input.origins?.length ?? 0) +
            (input.signouts?.length ?? 0) >
            0 ||
          input.sites !== undefined ||
          input.migrated === true ||
          input.cleared === true;
        if (!moves) return;
        const version = contents.version + 1;
        yield* file.commit({ ...input, version });
        contents.version = version;
        for (const [id, cookie] of input.cookies?.set ?? []) {
          contents.cookies.set(id, cookie);
          contents.tombstones.delete(id);
        }
        for (const [id, digest] of input.cookies?.removed ?? []) {
          contents.cookies.delete(id);
          contents.tombstones.set(id, digest);
        }
        for (const [id, origin] of input.origins ?? []) {
          contents.origins.set(id, origin);
          countDatabases(id, origin);
        }
        for (const [id, at] of input.signouts ?? []) contents.signouts.set(id, at);
        if (input.sites?.removed === "all") contents.sites.clear();
        else for (const id of input.sites?.removed ?? []) contents.sites.delete(id);
        for (const [id, site] of input.sites?.set ?? []) contents.sites.set(id, site);
        if (input.migrated === true) contents.migrated = true;
        if (input.cleared === true) contents.clearedAt = yield* Clock.currentTimeMillis;
        yield* publish;
      }),
    );

  /** Whether host `a` takes what the jar takes now. */
  const synced = (a: Attached) => !a.broken && a.baseline !== undefined;

  /** Gives every attached host but `from` cookies the jar took. */
  const pushCookies = (open: Open, from: Attached | undefined, changes: BrowserCookieChanges) =>
    Effect.forEach(
      hasCookieChanges(changes) ? [...attached].filter((a) => a !== from && a.cookies) : [],
      (a) =>
        Effect.gen(function* () {
          if (!synced(a) || a.baseline === undefined) return;
          const written = yield* hostCall("take cookies", a.host.writeCookies(changes));
          if (Option.isNone(written)) return yield* broke(a);
          const until = (yield* Clock.currentTimeMillis) + FENCE_MS;
          for (const cookie of changes.set) {
            const id = open.digests.cookieId(keyOfCookie(cookie));
            a.baseline.cookies.set(id, open.digests.cookieDigest(cookie));
            a.written.set(id, until);
          }
          for (const key of changes.removed) {
            const id = open.digests.cookieId(key);
            a.baseline.cookies.delete(id);
            a.written.set(id, until);
          }
          yield* saveBaseline(open, a);
        }),
      { discard: true },
    );

  /** The storage `origin` gives host `a`, as it reads it: its databases when both keep them. */
  const hostView = (a: Attached, origin: JarOrigin) => ({
    storage: storageView(origin.storage, a.indexedDb && origin.storage.indexedDb !== undefined),
  });

  /**
   * Origins host `a` wrote nothing of, as a page of them may hold their
   * databases open: each stays pending, and is reconciled again on its own
   * after a wait that grows with its tries, while the rest of the host syncs
   * on.
   */
  const waitOn = (a: Attached, ids: ReadonlyArray<Digest>): Effect.Effect<void> =>
    Effect.forEach(
      ids,
      (id) =>
        Effect.suspend(() => {
          a.pending.add(id);
          a.agreed = false;
          const waiting = a.waiting.get(id) ?? { tries: 0, retrying: false };
          a.waiting.set(id, waiting);
          waiting.tries += 1;
          if (waiting.retrying) return Effect.void;
          waiting.retrying = true;
          const wait = RETRY_MS[Math.min(waiting.tries, RETRY_MS.length) - 1] ?? RETRY_MS[0];
          return Effect.forkIn(
            Effect.sleep(wait).pipe(
              Effect.andThen(
                run(
                  Effect.suspend(() => {
                    waiting.retrying = false;
                    return attached.has(a) ? syncOrigin(a, id) : Effect.void;
                  }),
                ),
              ),
            ),
            a.scope,
          ).pipe(Effect.asVoid);
        }),
      { discard: true },
    );

  /** Origin `id` is written to host `a`, or needs no write: it waits no more. */
  const settled = (a: Attached, id: Digest) => {
    a.pending.delete(id);
    a.waiting.delete(id);
  };

  /** Gives every attached host but `from` origins the jar took. */
  const pushOrigins = (
    open: Open,
    from: Attached | undefined,
    origins: ReadonlyArray<readonly [Digest, JarOrigin]>,
  ) =>
    Effect.forEach(
      origins.length > 0 ? [...attached].filter((a) => a !== from && a.storage) : [],
      (a) =>
        Effect.gen(function* () {
          if (!synced(a) || a.baseline === undefined) return;
          const views = origins.map(([id, origin]) => [id, hostView(a, origin).storage] as const);
          const written = yield* hostCall(
            "take site storage",
            a.host.writeStorage(views.map(([, storage]) => storage)),
          );
          if (Option.isNone(written)) return yield* broke(a);
          const waiting = new Set(written.value.waiting ?? []);
          for (const [id, storage] of views) {
            if (waiting.has(storage.origin)) continue;
            settled(a, id);
            a.baseline.origins.set(id, open.digests.storageDigest(storage));
          }
          yield* saveBaseline(open, a);
          yield* waitOn(
            a,
            views.filter(([, storage]) => waiting.has(storage.origin)).map(([id]) => id),
          );
        }),
      { discard: true },
    );

  /** Whether a sign-out of a site of `sites`, or of all, came after `since`. */
  const revokedSince = (open: Open, since: number, sites: ReadonlyArray<BrowserSite>) =>
    [ALL_SITES, ...sites].some(
      (site) => (open.contents.signouts.get(open.digests.siteId(site)) ?? -1) > since,
    );

  /** Whether a site of `sites`, or every site, was ever signed out of. */
  const everSignedOut = (open: Open, sites: ReadonlyArray<BrowserSite>) =>
    [ALL_SITES, ...sites].some((site) => open.contents.signouts.has(open.digests.siteId(site)));

  /**
   * Removes from host `a` its cookies `matches` names, and the site data of
   * `clear`; its baseline follows. False when a call failed, and `a` broke.
   */
  const clearHost = Effect.fn("SignIns.clearHost")(function* (
    open: Open,
    a: Attached,
    matches: (sites: ReadonlyArray<BrowserSite>) => boolean,
    clear: PageHostPayload<"storage.clear">["clear"],
  ) {
    const { digests } = open;
    if (a.cookies) {
      // What the host holds, not only what the jar knew: a change on its
      // way to the jar goes too.
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) return yield* Effect.as(broke(a), false);
      const gone = read.value.cookies.filter((cookie) => matches(sitesOfCookie(cookie)));
      if (gone.length > 0) {
        const written = yield* hostCall(
          "take cookies",
          a.host.writeCookies({ set: [], removed: gone.map(keyOfCookie) }),
        );
        if (Option.isNone(written)) return yield* Effect.as(broke(a), false);
      }
      for (const cookie of gone) a.baseline?.cookies.delete(digests.cookieId(keyOfCookie(cookie)));
    }
    if (a.storage && ("all" in clear || clear.origins.length > 0)) {
      const cleared = yield* hostCall("clear site data", a.host.clearStorage(clear));
      if (Option.isNone(cleared)) return yield* Effect.as(broke(a), false);
      const ids =
        "all" in clear
          ? [...(a.baseline?.origins.keys() ?? [])]
          : clear.origins.map((origin) => digests.originId(origin));
      for (const id of ids) {
        const kept = open.contents.origins.get(id);
        if (kept === undefined) a.baseline?.origins.delete(id);
        else a.baseline?.origins.set(id, digests.storageDigest(hostView(a, kept).storage));
        settled(a, id);
      }
    }
    return true;
  });

  /**
   * Clears on host `a` the site data of every sign-out after `since` that
   * it missed: all of it after a sign-out of all sites, else each origin
   * the jar keeps, or a tab of the host shows, of a site signed out of.
   * False when a call failed, and `a` broke.
   */
  const clearMissed = (open: Open, a: Attached, since: number) =>
    Effect.suspend(() => {
      const revoked = (sites: ReadonlyArray<BrowserSite>) => revokedSince(open, since, sites);
      if (revoked([])) return clearHost(open, a, () => true, { all: true });
      const origins = new Set<string>();
      const candidates = [
        ...[...open.contents.origins.values()].map((kept) => kept.storage.origin),
        ...[...a.tabs.values()].flatMap((tab) => (tab.private ? [] : [tab.url])),
      ];
      for (const candidate of candidates) {
        const origin = originOf(candidate);
        const site = origin === undefined ? undefined : siteOfOrigin(origin);
        if (origin !== undefined && site !== undefined && revoked([site])) origins.add(origin);
      }
      return origins.size === 0
        ? Effect.succeed(true)
        : clearHost(open, a, revoked, { origins: [...origins] });
    });

  /** `a`'s origins are all reconciled: every sign-out up to its reconcile reached it. */
  const agree = (open: Open, a: Attached) =>
    Effect.suspend(() => {
      if (a.broken || a.pending.size > 0 || a.agreed) return Effect.void;
      a.agreed = true;
      // Only a host agreed in full is well again: one whose origins keep
      // failing waits longer each time.
      a.failures = 0;
      a.since = Math.max(a.since, a.agreeing, a.signedOut);
      return saveBaseline(open, a);
    });

  /** Brings host `a`'s cookies and the jar together, and queues its origins. */
  const reconcile = Effect.fn("SignIns.reconcile")(function* (a: Attached) {
    const open = openJar();
    if (open === undefined) return;
    const { contents, file, digests } = open;
    const now = yield* Clock.currentTimeMillis;
    // A host reconciled again in the same attachment keeps what it had:
    // the store's own, when it has none to keep across starts.
    const kept: StoreBaseline | undefined =
      a.baseline !== undefined
        ? { version: a.since, run: a.run, ...a.baseline, dropped: false }
        : a.store === undefined
          ? undefined
          : Option.getOrUndefined(yield* file.baseline(a.store));
    a.since = kept?.version ?? -1;
    // What it held, when the server still knows it: a store unseen for 90
    // days is agreed as a new one is, though the sign-outs since still win.
    const stored = kept?.dropped === true ? undefined : kept;
    a.signedOut = -1;
    a.agreed = false;
    a.pending.clear();
    a.waiting.clear();
    // A store the jar does not know, after the person signed out of all
    // sites lately: what it holds is from before, and goes first.
    if (
      kept === undefined &&
      contents.clearedAt !== undefined &&
      now - contents.clearedAt < KEPT_MS
    )
      if (!(yield* clearHost(open, a, () => true, { all: true }))) return;
    // A store the jar knows, that missed sign-outs while it was away or a
    // clear failed: what those sites stored goes before anything of the
    // host's is taken.
    if (kept !== undefined && !(yield* clearMissed(open, a, kept.version))) return;
    let cookies = new Map(stored?.cookies ?? []);
    if (a.cookies) {
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) return yield* broke(a);
      const since = a.since;
      const plan = reconcileCookies({
        jar: contents.cookies,
        tombstones: contents.tombstones,
        baseline: stored?.cookies,
        restarted: stored?.run === undefined || a.run === undefined || stored.run !== a.run,
        revoked: (cookie) => kept !== undefined && revokedSince(open, since, sitesOfCookie(cookie)),
        host: read.value.cookies,
        now,
        digests,
      });
      const others = forOthers(contents, plan.jar);
      yield* change(open, { cookies: plan.jar });
      yield* pushCookies(open, a, others);
      if (hasCookieChanges(plan.host)) {
        const written = yield* hostCall("take cookies", a.host.writeCookies(plan.host));
        if (Option.isNone(written)) return yield* broke(a);
      }
      cookies = new Map(plan.baseline);
    }
    const origins = new Map(stored?.origins ?? []);
    if (a.storage) {
      for (const id of origins.keys()) if (!contents.origins.has(id)) origins.delete(id);
      for (const [id, kept] of contents.origins) {
        const known = origins.get(id);
        if (stored === undefined) {
          origins.set(id, UNKNOWN);
          a.pending.add(id);
        } else if (
          known === undefined
            ? !isEmptyStorage(hostView(a, kept).storage)
            : known !== digests.storageDigest(hostView(a, kept).storage)
        )
          a.pending.add(id);
      }
    }
    a.baseline = { cookies, origins };
    a.agreeing = contents.version;
    a.broken = false;
    yield* saveBaseline(open, a);
    yield* agree(open, a);
    yield* Effect.forkIn(seed(a), a.scope);
  });

  /**
   * Brings host `a`'s `reads` of origins and the jar together: what the host
   * changed since its baseline goes to the jar and the other hosts, and what
   * the jar changed goes to the host.
   */
  const settle = Effect.fn("SignIns.settle")(function* (
    open: Open,
    a: Attached,
    reads: ReadonlyArray<BrowserOriginStorage>,
  ) {
    const { contents, digests } = open;
    if (a.baseline === undefined) return;
    const taken: Array<readonly [Digest, JarOrigin]> = [];
    const given: Array<BrowserOriginStorage> = [];
    const next = new Map<Digest, Digest>();
    for (const read of reads) {
      const id = digests.originId(read.origin);
      const known = a.baseline.origins.get(id);
      const site = siteOfOrigin(read.origin);
      const plan = reconcileOrigin({
        kept: contents.origins.get(id),
        read,
        room: roomFor(id),
        baseline: known === UNKNOWN ? "none" : known,
        revoked: site !== undefined && revokedSince(open, a.since, [site]),
        digests,
      });
      if (plan.jar !== undefined) {
        taken.push([id, plan.jar]);
        // Counted now, so the next origin of the batch has the room left.
        countDatabases(id, plan.jar);
      }
      if (plan.host !== undefined) given.push(plan.host);
      next.set(id, plan.baseline);
    }
    yield* change(open, { origins: taken });
    let waiting = new Set<Digest>();
    if (given.length > 0) {
      const written = yield* hostCall("take site storage", a.host.writeStorage(given));
      if (Option.isNone(written)) return yield* broke(a);
      waiting = new Set((written.value.waiting ?? []).map((origin) => digests.originId(origin)));
    }
    for (const [id, digest] of next) {
      if (waiting.has(id)) continue;
      a.baseline.origins.set(id, digest);
      settled(a, id);
    }
    yield* saveBaseline(open, a);
    yield* waitOn(a, [...waiting]);
    yield* pushOrigins(open, a, taken);
    yield* agree(open, a);
  });

  /** Reads `origins` from host `a`, each with its databases where the jar keeps them. */
  const readOrigins = Effect.fn("SignIns.readOrigins")(function* (
    open: Open,
    a: Attached,
    origins: ReadonlyArray<string>,
  ) {
    const { contents, digests } = open;
    // Every origin's databases, but those too big to carry.
    const keepsDatabases = (origin: string) =>
      a.indexedDb && contents.origins.get(digests.originId(origin))?.tooBig !== true;
    const reads: Array<BrowserOriginStorage> = [];
    for (const indexedDb of [false, true]) {
      const batch = origins.filter((origin) => keepsDatabases(origin) === indexedDb);
      if (batch.length === 0) continue;
      const read = yield* hostCall(
        "give site storage",
        a.host.readStorage({ origins: batch, indexedDb }),
      );
      if (Option.isNone(read)) return Option.none<typeof reads>();
      for (const origin of batch) {
        const held = read.value.origins.find((each) => each.origin === origin);
        // Databases asked for and not read hold what the host could not give:
        // the origin is left as it is, on both sides, until it can be read.
        if (indexedDb && held !== undefined && held.indexedDb === undefined) continue;
        reads.push(held ?? storageView(emptyStorage(origin), indexedDb));
      }
    }
    return Option.some(reads);
  });

  /** Reconciles one origin of host `a` that is still pending. */
  const syncOrigin = Effect.fn("SignIns.syncOrigin")(function* (a: Attached, id: Digest) {
    const open = openJar();
    if (open === undefined || !synced(a) || !a.pending.has(id)) return;
    const kept = open.contents.origins.get(id);
    if (kept === undefined) {
      a.pending.delete(id);
      return yield* agree(open, a);
    }
    const reads = yield* readOrigins(open, a, [kept.storage.origin]);
    if (Option.isNone(reads)) return yield* broke(a);
    yield* settle(open, a, reads.value);
  });

  /** Takes every origin still pending on `a`, one at a time. */
  const seed = (a: Attached): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (synced(a)) {
        const [next] = a.pending;
        if (next === undefined) return;
        yield* run(syncOrigin(a, next));
      }
    });

  /**
   * Whether a report of host `a` may be from before what the server did to
   * it lately: it touches a site signed out of, or a cookie written to it.
   */
  const fenced = (a: Attached, reported: BrowserCookieChanges, digests: Digests, now: number) => {
    for (const [site, until] of a.fences) if (until <= now) a.fences.delete(site);
    for (const [id, until] of a.written) if (until <= now) a.written.delete(id);
    const ids = [...reported.set.map(keyOfCookie), ...reported.removed].map(digests.cookieId);
    return (
      a.fences.has(ALL_SITES) ||
      sitesOfChanges(reported).some((site) => a.fences.has(site)) ||
      ids.some((id) => a.written.has(id))
    );
  };

  /** Cookies host `a` changed, as it reported them or a read found. */
  const takeCookies = Effect.fn("SignIns.takeCookies")(function* (
    a: Attached,
    reported: BrowserCookieChanges,
  ) {
    const open = openJar();
    if (open === undefined || !synced(a) || a.baseline === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    let changes = reported;
    if (fenced(a, reported, open.digests, now)) {
      // The report may be from before the sign-out or the write reached
      // the host: what the host holds now says.
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) return yield* broke(a);
      changes = diffHostCookies({
        baseline: a.baseline.cookies,
        host: read.value.cookies,
        jar: open.contents.cookies,
        digests: open.digests,
      });
    }
    const plan = takeHostCookies({
      jar: open.contents.cookies,
      changes,
      now,
      digests: open.digests,
    });
    const others = plan.others;
    yield* change(open, { cookies: plan.jar });
    for (const [id, digest] of plan.baseline)
      if (digest === undefined) a.baseline.cookies.delete(id);
      else a.baseline.cookies.set(id, digest);
    yield* saveBaseline(open, a);
    yield* pushCookies(open, a, others);
  });

  /** Origins whose storage host `a` may have changed: read, and brought together with the jar. */
  const takeOrigins = Effect.fn("SignIns.takeOrigins")(function* (
    a: Attached,
    origins: ReadonlyArray<string>,
  ) {
    const open = openJar();
    if (open === undefined || !synced(a)) return false;
    const wanted = [...new Set(origins.flatMap((origin) => originOf(origin) ?? []))];
    if (wanted.length === 0) return true;
    const reads = yield* readOrigins(open, a, wanted);
    if (Option.isNone(reads)) {
      yield* broke(a);
      return false;
    }
    yield* settle(open, a, reads.value);
    return synced(a);
  });

  /** Reads a host without change events again, and takes what changed. */
  const readAgain = Effect.fn("SignIns.readAgain")(function* (a: Attached) {
    const open = openJar();
    if (open === undefined || !synced(a) || a.baseline === undefined) return;
    if (a.cookies) {
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) return yield* broke(a);
      yield* takeCookies(
        a,
        diffHostCookies({
          baseline: a.baseline.cookies,
          host: read.value.cookies,
          jar: open.contents.cookies,
          digests: open.digests,
        }),
      );
    }
    if (a.storage) {
      const touched = [...a.touched];
      const shown = [...a.tabs.values()].filter((tab) => !tab.private).map((tab) => tab.url);
      if (yield* takeOrigins(a, [...shown, ...touched]))
        for (const origin of touched) a.touched.delete(origin);
    }
  });

  /** The site of a page a shared tab shows, which the list of sites names. */
  const shown = Effect.fn("SignIns.shown")(function* (a: Attached, url: string) {
    const origin = originOf(url);
    if (origin === undefined) return;
    a.seen.add(origin);
    const open = openJar();
    const site = siteOfOrigin(origin);
    if (open === undefined || site === undefined) return;
    const id = open.digests.siteId(site);
    if (open.contents.sites.has(id)) return;
    yield* change(open, { sites: { set: [[id, site]], removed: [] } });
  });

  /** Signs out of `signout` (a site, or every one), in the jar and on every attached host. */
  const signOutOf = Effect.fn("SignIns.signOutOf")(function* (signout: BrowserSite) {
    const open = openJar();
    if (open === undefined) return;
    const { contents, digests } = open;
    const all = signout === ALL_SITES;
    const matches = (sites: ReadonlyArray<BrowserSite>) => all || sites.includes(signout);
    const removed: Array<readonly [Digest, Digest]> = [];
    for (const [id, cookie] of contents.cookies)
      if (matches(sitesOfCookie(cookie))) removed.push([id, digests.cookieDigest(cookie)]);
    const empties: Array<readonly [Digest, JarOrigin]> = [];
    const known: Array<string> = [];
    for (const [id, origin] of contents.origins) {
      const site = siteOfOrigin(origin.storage.origin);
      if (site === undefined || !matches([site])) continue;
      known.push(origin.storage.origin);
      if (!isEmptyStorage(origin.storage)) empties.push([id, emptied(origin)]);
    }
    const version = contents.version + 1;
    yield* change(open, {
      cookies: { set: [], removed },
      origins: empties,
      signouts: [[digests.siteId(signout), version]],
      sites: { set: [], removed: all ? "all" : [digests.siteId(signout)] },
      cleared: all,
    });
    const now = yield* Clock.currentTimeMillis;
    for (const a of attached) {
      if (!synced(a)) continue;
      a.fences.set(signout, now + FENCE_MS);
      const origins = new Set(known);
      for (const origin of [...a.seen, ...[...a.tabs.values()].map((tab) => tab.url)]) {
        const site = siteOfOrigin(origin);
        const at = originOf(origin);
        if (site !== undefined && at !== undefined && matches([site])) origins.add(at);
      }
      const done = yield* clearHost(
        open,
        a,
        matches,
        all ? { all: true } : { origins: [...origins] },
      );
      // A report the host queued before the clear may come only now: the
      // fence runs from when the clear reached it.
      a.fences.set(signout, (yield* Clock.currentTimeMillis) + FENCE_MS);
      if (!done) continue;
      if (a.agreed) a.since = Math.max(a.since, version);
      else a.signedOut = version;
      yield* saveBaseline(open, a);
    }
  });

  const idle: SignInsAttachment = {
    event: () => Effect.void,
    flush: Effect.void,
    prepare: () => Effect.void,
  };

  const attach = Effect.fn("SignIns.attach")(function* (host: PageHost, hello: BrowserHostHello) {
    if (jar._tag === "keyless") return idle;
    const { capabilities } = hello;
    const { digests } = jar;
    const a: Attached = {
      host,
      scope: yield* Effect.scope,
      store: hello.cookieStore === undefined ? undefined : digests.storeId(hello.cookieStore),
      run: hello.browserRun === undefined ? undefined : digests.runId(hello.browserRun),
      cookies: capabilities.cookies === true,
      storage: capabilities.storage === true,
      indexedDb: capabilities.indexedDb === true,
      events: capabilities.changeEvents === true,
      baseline: undefined,
      since: -1,
      agreeing: -1,
      signedOut: -1,
      agreed: false,
      pending: new Set(),
      waiting: new Map(),
      tabs: new Map<BrowserTabRef, { url: string; readonly private: boolean }>([
        ...hello.tabs.map((page) => [page.tab, { url: page.url, private: false }] as const),
        ...(hello.privateTabs ?? []).map(
          (page) => [page.tab, { url: page.url, private: true }] as const,
        ),
      ]),
      touched: new Set(),
      seen: new Set(),
      fences: new Map(),
      written: new Map(),
      broken: false,
      retrying: false,
      failures: 0,
    };
    if (!a.cookies && !a.storage) return idle;
    yield* Effect.acquireRelease(
      Effect.sync(() => attached.add(a)),
      () => Effect.sync(() => attached.delete(a)),
    );
    yield* run(
      Effect.gen(function* () {
        for (const page of hello.tabs) yield* shown(a, page.url);
        yield* reconcile(a);
      }),
    );

    const reads = yield* Queue.sliding<void>(1);
    if (!a.events) {
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(reads).pipe(
            Effect.andThen(Effect.sleep(READ_AFTER_LOAD_MS)),
            Effect.andThen(run(readAgain(a))),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Effect.suspend(() =>
          [...a.tabs.values()].some((tab) => !tab.private)
            ? Queue.offer(reads, undefined)
            : Effect.void,
        ).pipe(Effect.delay(READ_EVERY), Effect.forever),
      );
    }
    const readSoon = a.events ? Effect.void : Queue.offer(reads, undefined).pipe(Effect.asVoid);
    /** The origin a shared tab showed, which a host without change events reads once more. */
    const leaving = (url: string) => {
      const origin = originOf(url);
      if (origin !== undefined && !a.events) a.touched.add(origin);
    };

    const event = (incoming: BrowserHostEvent): Effect.Effect<void> => {
      switch (incoming.type) {
        case "tab.opened":
          a.tabs.set(incoming.page.tab, { url: incoming.page.url, private: incoming.private });
          return incoming.private || incoming.page.loading || incoming.page.loadError !== null
            ? Effect.void
            : run(shown(a, incoming.page.url));
        case "tab.changed": {
          const page = incoming.page;
          const tab = a.tabs.get(page.tab);
          if (tab?.private === true) {
            tab.url = page.url;
            return Effect.void;
          }
          // A tab the server opened is never private: a private one opens
          // only in the app, which reports it (`tab.opened`, the hello).
          if (tab === undefined) a.tabs.set(page.tab, { url: page.url, private: false });
          else {
            if (originOf(tab.url) !== originOf(page.url)) leaving(tab.url);
            tab.url = page.url;
          }
          if (page.loading) return Effect.void;
          return (page.loadError === null ? run(shown(a, page.url)) : Effect.void).pipe(
            Effect.andThen(readSoon),
          );
        }
        case "tab.closed": {
          const tab = a.tabs.get(incoming.tab);
          a.tabs.delete(incoming.tab);
          if (tab === undefined || tab.private) return Effect.void;
          leaving(tab.url);
          return readSoon;
        }
        case "cookies.changed":
          return run(takeCookies(a, incoming.changes));
        case "storage.changed":
          return run(takeOrigins(a, incoming.origins)).pipe(Effect.asVoid);
        case "tab.focused":
        case "person.input":
        case "pointer":
        case "download.started":
        case "download.finished":
          return Effect.void;
      }
    };
    const prepare = (url: string) =>
      Effect.suspend(() => {
        const origin = originOf(url);
        if (origin === undefined) return Effect.void;
        const id = digests.originId(origin);
        if (!a.pending.has(id)) return Effect.void;
        // The origin's reconcile goes on to its end; the tab waits for it a
        // few seconds at most.
        return Effect.forkIn(lock.withPermit(syncOrigin(a, id)), scope).pipe(
          Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.timeout(PREPARE_MS))),
          Effect.ignore,
        );
      });
    return {
      event,
      flush: a.events ? Effect.void : run(readAgain(a)),
      prepare,
    } satisfies SignInsAttachment;
  });

  const signOutSite = (site: BrowserSite) => run(signOutOf(site));

  const signOut = run(
    Effect.gen(function* () {
      if (jar._tag === "keyless") return yield* new Conflict({ reason: "secrets-unavailable" });
      if (jar._tag === "open") return yield* signOutOf(ALL_SITES);
      const fresh = yield* jar.reset;
      jar = {
        _tag: "open",
        file: fresh.file,
        digests: jar.digests,
        contents: { ...fresh.contents },
      };
      countAll();
      // Recorded as a sign-out of all sites: the engine's old profile, still
      // due to move, brings nothing of before back.
      yield* signOutOf(ALL_SITES);
      yield* publish;
      // Hosts that attached while the jar was unreadable: nothing of theirs
      // was synced, and the reconcile of a store the jar does not know,
      // just after the jar was emptied, empties it first.
      for (const a of attached) yield* reconcile(a);
    }),
  );

  const toBringIn = Effect.sync(() =>
    jar._tag !== "open" ? "unavailable" : jar.contents.migrated ? "done" : "due",
  );

  const bringIn = (input: {
    readonly cookies: ReadonlyArray<BrowserCookie>;
    readonly origins: ReadonlyArray<BrowserOriginStorage>;
    readonly sites: ReadonlyArray<BrowserSite>;
  }) =>
    run(
      Effect.gen(function* () {
        const open = openJar();
        if (open === undefined || open.contents.migrated) return;
        const { contents, digests } = open;
        const plan = reconcileCookies({
          jar: contents.cookies,
          tombstones: contents.tombstones,
          baseline: undefined,
          restarted: false,
          revoked: () => false,
          host: input.cookies.filter((cookie) => !everSignedOut(open, sitesOfCookie(cookie))),
          now: yield* Clock.currentTimeMillis,
          digests,
        });
        const origins: Array<readonly [Digest, JarOrigin]> = [];
        for (const storage of input.origins) {
          const site = siteOfOrigin(storage.origin);
          if (site === undefined || isEmptyStorage(storage) || everSignedOut(open, [site]))
            continue;
          const id = digests.originId(storage.origin);
          const kept = contents.origins.get(id);
          if (kept !== undefined && !isEmptyStorage(kept.storage)) continue;
          // Databases are carried as any host's are: within the room left.
          const origin: JarOrigin =
            databaseBytes(storage.indexedDb) > roomFor(id)
              ? { storage: storageView(storage, false), tooBig: true }
              : { storage };
          countDatabases(id, origin);
          origins.push([id, origin]);
        }
        const sites = [...new Set(input.sites)]
          .filter((site) => !everSignedOut(open, [site]))
          .map((site) => [digests.siteId(site), site] as const)
          .filter(([id]) => !contents.sites.has(id));
        const cookies: JarCookieChanges = { set: plan.jar.set, removed: [] };
        yield* change(open, {
          cookies,
          origins,
          sites: { set: sites, removed: [] },
          migrated: true,
        });
        yield* pushCookies(open, undefined, forOthers(contents, cookies));
        yield* pushOrigins(open, undefined, origins);
      }),
    );

  return SignIns.of({
    attach,
    view: SubscriptionRef.changes(view),
    signOutSite,
    signOut,
    toBringIn,
    bringIn,
  });
});

/**
 * The sign-ins of the home: the jar in `browser/signins.sqlite`, sealed
 * under the secrets' subkey for them. Secrets that cannot be read leave the
 * sign-ins locked, and the file untouched.
 */
export const layer = Layer.effect(
  SignIns,
  Effect.gen(function* () {
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const secrets = yield* Secrets;
    const key = yield* Effect.option(secrets.subkey("browser-sign-ins"));
    if (Option.isNone(key)) {
      yield* Effect.logWarning(
        "The secrets cannot be read, so neither can the browser's sign-ins: nothing is synced",
      );
      return yield* makeSignIns(undefined);
    }
    const folder = yield* layout.writable(layout.browser).pipe(Effect.orDie);
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    yield* fs.chmod(folder, 0o700).pipe(Effect.orDie);
    const jar = yield* openJarFile(path.join(folder, SIGNINS_FILE), key.value);
    return yield* makeSignIns({ jar, digests: makeDigests(key.value) });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
