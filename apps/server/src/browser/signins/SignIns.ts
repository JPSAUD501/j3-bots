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
import type { PageHost } from "@j3-bots/browser";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  type OpenedJar,
  openJarFile,
  SIGNINS_FILE,
} from "./JarFile.ts";
import {
  diffHostCookies,
  hasCookieChanges,
  type JarCookieChanges,
  type JarOrigin,
  reconcileCookies,
  reconcileOrigin,
  takeHostCookies,
  takeOrigin,
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
// so two hosts' changes are never interleaved.

/** How long one host call of the sync may take. */
const HOST_CALL_MS = 15_000;
/** How long `prepare` waits for an origin's storage before the tab opens anyway. */
const PREPARE_MS = 5_000;
/** How often a host without change events is read while it has a tab open. */
const READ_EVERY = "60 seconds";
/** How long a page load waits before the read it asks for, so loads in a row read once. */
const READ_AFTER_LOAD_MS = 1_000;

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
    /** Whether the sign-ins of before 0.16 are still to be brought in. */
    readonly toBringIn: Effect.Effect<boolean>;
    /**
     * Brings in the sign-ins of before 0.16, once: what the jar does not
     * hold is added, and nothing it holds is replaced.
     */
    readonly bringIn: (input: {
      readonly cookies: ReadonlyArray<BrowserCookie>;
      readonly origins: ReadonlyArray<JarOrigin>;
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
  | { readonly _tag: "unreadable"; readonly file: JarFile; readonly digests: Digests }
  | { readonly _tag: "keyless" };

interface MutableContents extends Omit<JarContents, "version" | "migrated"> {
  version: number;
  migrated: boolean;
}

/** One attached host and what the sync knows of it. */
interface Attached {
  readonly host: PageHost;
  /** The attachment's scope, where its background work runs. */
  readonly scope: Scope.Scope;
  /** Its store's id, when it keeps one across starts. */
  readonly store: Digest | undefined;
  readonly cookies: boolean;
  readonly storage: boolean;
  readonly indexedDb: boolean;
  readonly events: boolean;
  /** What it holds as of its last agreement with the jar; none until its cookies are reconciled. */
  baseline:
    | { readonly cookies: Map<Digest, Digest>; readonly origins: Map<Digest, Digest> }
    | undefined;
  /** The version its store last agreed at, which a sign-out after wins over. */
  since: number | undefined;
  /** Origins whose storage is still to be reconciled. */
  readonly pending: Set<Digest>;
  /** Whether the store had no baseline when it attached: its pending origins are new to it. */
  fresh: boolean;
  /** Its tabs, and whether each is private: only shared tabs' pages are read. */
  readonly tabs: Map<BrowserTabRef, { url: string; readonly private: boolean }>;
  /** A write to it failed: it is synced again only when it attaches again. */
  broken: boolean;
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

/** What the jar holds when it starts again, empty. */
const emptyContents = (): MutableContents => ({
  version: 0,
  cookies: new Map(),
  tombstones: new Map(),
  origins: new Map(),
  signouts: new Map(),
  migrated: false,
});

/** The changes other hosts take for what the jar took, read before the jar takes it. */
const forOthers = (contents: MutableContents, changes: JarCookieChanges): BrowserCookieChanges => ({
  set: changes.set.map(([, cookie]) => cookie),
  removed: changes.removed.flatMap(([id]) => {
    const kept = contents.cookies.get(id);
    return kept === undefined ? [] : [keyOfCookie(kept)];
  }),
});

/**
 * The sign-ins over `opened`, the jar as it opened under the key `digests`
 * names by. None: the secrets had no key to open it with.
 */
export const makeSignIns = Effect.fn("SignIns.make")(function* (
  opened: { readonly jar: OpenedJar; readonly digests: Digests } | undefined,
) {
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
        : { _tag: "unreadable", file: opened.jar.file, digests: opened.digests };
  const lock = Semaphore.makeUnsafe(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect);
  const attached = new Set<Attached>();
  /** The jar when it is open, for a change; a change on a jar that is not does nothing. */
  const openJar = (): Open | undefined => (jar._tag === "open" ? jar : undefined);

  const viewOf = (now: number): BrowserSignIns => {
    if (jar._tag !== "open") return { status: "unreadable", sites: [] };
    const sites = new Set<BrowserSite>();
    for (const cookie of jar.contents.cookies.values())
      if (!expiredAt(cookie, now)) sites.add(siteOfHost(cookie.domain));
    for (const { storage } of jar.contents.origins.values()) {
      const site = siteOfOrigin(storage.origin);
      if (site !== undefined && !isEmptyStorage(storage)) sites.add(site);
    }
    return { status: "ready", sites: [...sites].sort().map((site) => ({ site })) };
  };
  const view = yield* SubscriptionRef.make(viewOf(yield* Clock.currentTimeMillis));
  const publish = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    SubscriptionRef.set(view, viewOf(now)),
  );

  /** A call to a host; its failure is logged, and answers none. */
  const hostCall = <A>(what: string, call: Effect.Effect<A, BrowserHostError>) =>
    call.pipe(
      Effect.timeout(HOST_CALL_MS),
      Effect.asSome,
      Effect.catch((error) =>
        Effect.logWarning(`A browser host did not ${what}`).pipe(
          Effect.annotateLogs({ detail: error.message }),
          Effect.as(Option.none<A>()),
        ),
      ),
    );

  /** Host `a`'s baseline as the file keeps it, whole, at the jar's version now. */
  const saveBaseline = (open: Open, a: Attached) =>
    a.store === undefined || a.baseline === undefined
      ? Effect.void
      : open.file.commit({
          version: open.contents.version,
          stores: [
            {
              id: a.store,
              version: open.contents.version,
              replace: true,
              cookies: a.baseline.cookies,
              origins: a.baseline.origins,
            },
          ],
        });

  /** A host whose write failed: synced no more until it attaches again. */
  const broke = Effect.fn("SignIns.broke")(function* (open: Open, a: Attached) {
    a.broken = true;
    a.baseline = undefined;
    if (a.store !== undefined)
      yield* open.file.commit({ version: open.contents.version, droppedStores: [a.store] });
  });

  /**
   * Writes a change to the jar and the file; the jar's version moves on
   * when the change holds anything.
   */
  const change = Effect.fn("SignIns.change")(function* (
    open: Open,
    input: Omit<JarCommit, "version">,
  ) {
    const { contents, file } = open;
    const moves =
      (input.cookies?.set.length ?? 0) +
        (input.cookies?.removed.length ?? 0) +
        (input.origins?.length ?? 0) +
        (input.signouts?.length ?? 0) >
        0 || input.migrated === true;
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
    for (const [id, origin] of input.origins ?? []) contents.origins.set(id, origin);
    for (const [id, at] of input.signouts ?? []) contents.signouts.set(id, at);
    if (input.migrated === true) contents.migrated = true;
    yield* publish;
  });

  /** Whether host `a` takes what the jar takes now. */
  const synced = (a: Attached) => !a.broken && a.baseline !== undefined;

  /** Gives every attached host but `from` cookies the jar took. */
  const pushCookies = (open: Open, from: Attached | undefined, changes: BrowserCookieChanges) =>
    Effect.forEach(
      hasCookieChanges(changes) ? [...attached].filter((a) => a !== from && a.cookies) : [],
      (a) =>
        Effect.gen(function* () {
          if (!synced(a)) return;
          const written = yield* hostCall("take cookies", a.host.writeCookies(changes));
          if (Option.isNone(written) || a.baseline === undefined) return yield* broke(open, a);
          for (const cookie of changes.set)
            a.baseline.cookies.set(
              open.digests.cookieId(keyOfCookie(cookie)),
              open.digests.cookieDigest(cookie),
            );
          for (const key of changes.removed) a.baseline.cookies.delete(open.digests.cookieId(key));
          yield* saveBaseline(open, a);
        }),
      { discard: true },
    );

  /** The storage `origin` gives host `a`, as it reads it, and whether databases are in it. */
  const hostView = (a: Attached, origin: JarOrigin) => {
    const indexedDb = a.indexedDb && origin.indexedDb;
    return { indexedDb, storage: storageView(origin.storage, indexedDb) };
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
          if (!synced(a)) return;
          const views = origins.map(([id, origin]) => [id, hostView(a, origin).storage] as const);
          const written = yield* hostCall(
            "take site storage",
            a.host.writeStorage(views.map(([, storage]) => storage)),
          );
          if (Option.isNone(written) || a.baseline === undefined) return yield* broke(open, a);
          for (const [id, storage] of views) {
            a.pending.delete(id);
            a.baseline.origins.set(id, open.digests.storageDigest(storage));
          }
          yield* saveBaseline(open, a);
        }),
      { discard: true },
    );

  /** Whether a sign-out of a site of `sites`, or of all, came after `since`. */
  const revokedSince = (open: Open, since: number, sites: ReadonlyArray<BrowserSite>) =>
    [ALL_SITES, ...sites].some(
      (site) => (open.contents.signouts.get(open.digests.siteId(site)) ?? -1) > since,
    );

  /** Brings host `a`'s cookies and the jar together, and queues its origins. */
  const reconcile = Effect.fn("SignIns.reconcile")(function* (a: Attached) {
    const open = openJar();
    if (open === undefined) return;
    const { contents, file, digests } = open;
    a.broken = false;
    const baseline =
      a.store === undefined ? undefined : Option.getOrUndefined(yield* file.baseline(a.store));
    a.since = baseline?.version;
    a.fresh = baseline === undefined;
    const origins = new Map(baseline?.origins ?? []);
    let cookies = new Map<Digest, Digest>();
    if (a.cookies) {
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) return yield* broke(open, a);
      const plan = reconcileCookies({
        jar: contents.cookies,
        tombstones: contents.tombstones,
        baseline: baseline?.cookies,
        revoked: (cookie) =>
          baseline !== undefined && revokedSince(open, baseline.version, sitesOfCookie(cookie)),
        host: read.value.cookies,
        now: yield* Clock.currentTimeMillis,
        digests,
      });
      const others = forOthers(contents, plan.jar);
      yield* change(open, { cookies: plan.jar });
      yield* pushCookies(open, a, others);
      if (hasCookieChanges(plan.host)) {
        const written = yield* hostCall("take cookies", a.host.writeCookies(plan.host));
        if (Option.isNone(written)) return yield* broke(open, a);
      }
      cookies = new Map(plan.baseline);
    }
    a.baseline = { cookies, origins };
    if (a.storage) {
      for (const [id, kept] of contents.origins) {
        const known = origins.get(id);
        const view = hostView(a, kept).storage;
        if (known === undefined ? !isEmptyStorage(view) : known !== digests.storageDigest(view))
          a.pending.add(id);
      }
      for (const id of origins.keys()) if (contents.origins.has(id)) a.pending.add(id);
    }
    yield* saveBaseline(open, a);
    yield* Effect.forkIn(seed(a), a.scope);
  });

  /** Reconciles one origin of host `a` that is still pending. */
  const syncOrigin = Effect.fn("SignIns.syncOrigin")(function* (a: Attached, id: Digest) {
    const open = openJar();
    if (!a.pending.delete(id) || open === undefined || a.baseline === undefined) return;
    const { contents, digests } = open;
    const kept = contents.origins.get(id);
    if (kept === undefined) return;
    const { indexedDb } = hostView(a, kept);
    const read = yield* hostCall(
      "give site storage",
      a.host.readStorage({ origins: [kept.storage.origin], indexedDb }),
    );
    if (Option.isNone(read)) return yield* broke(open, a);
    const held =
      read.value.origins.find((origin) => origin.origin === kept.storage.origin) ??
      storageView(emptyStorage(kept.storage.origin), indexedDb);
    const known = a.baseline.origins.get(id);
    const site = siteOfOrigin(kept.storage.origin);
    const plan = reconcileOrigin({
      kept,
      read: held,
      indexedDb,
      baseline: a.fresh && known === undefined ? "none" : known,
      revoked: a.since !== undefined && site !== undefined && revokedSince(open, a.since, [site]),
      digests,
    });
    if (plan.jar !== undefined) {
      const taken = [[id, plan.jar]] as const;
      yield* change(open, { origins: taken });
      yield* pushOrigins(open, a, taken);
    }
    if (plan.host !== undefined) {
      const written = yield* hostCall("take site storage", a.host.writeStorage([plan.host]));
      if (Option.isNone(written)) return yield* broke(open, a);
    }
    a.baseline?.origins.set(id, plan.baseline);
    yield* saveBaseline(open, a);
  });

  /** Takes every origin still pending on `a`, one at a time, each under the lock. */
  const seed = (a: Attached): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (!a.broken) {
        const [next] = a.pending;
        if (next === undefined) return;
        yield* locked(syncOrigin(a, next));
      }
    });

  /** Cookies host `a` changed, as it reported them or a read found. */
  const takeCookies = Effect.fn("SignIns.takeCookies")(function* (
    a: Attached,
    changes: BrowserCookieChanges,
  ) {
    const open = openJar();
    if (open === undefined || !synced(a)) return;
    const plan = takeHostCookies({
      jar: open.contents.cookies,
      changes,
      now: yield* Clock.currentTimeMillis,
      digests: open.digests,
    });
    yield* change(open, { cookies: plan.jar });
    for (const [id, digest] of plan.baseline)
      if (digest === undefined) a.baseline?.cookies.delete(id);
      else a.baseline?.cookies.set(id, digest);
    yield* saveBaseline(open, a);
    yield* pushCookies(open, a, plan.others);
  });

  /** Origins whose storage host `a` may have changed: read, and what changed taken. */
  const takeOrigins = Effect.fn("SignIns.takeOrigins")(function* (
    a: Attached,
    origins: ReadonlyArray<string>,
  ) {
    const open = openJar();
    if (open === undefined || !synced(a)) return;
    const { contents, digests } = open;
    const wanted = [...new Set(origins.flatMap((origin) => originOf(origin) ?? []))];
    const keepsDatabases = (origin: string) =>
      a.indexedDb && contents.origins.get(digests.originId(origin))?.indexedDb === true;
    const reads: Array<BrowserOriginStorage> = [];
    for (const indexedDb of [false, true]) {
      const batch = wanted.filter((origin) => keepsDatabases(origin) === indexedDb);
      if (batch.length === 0) continue;
      const read = yield* hostCall(
        "give site storage",
        a.host.readStorage({ origins: batch, indexedDb }),
      );
      if (Option.isNone(read)) return;
      reads.push(...read.value.origins.filter((held) => batch.includes(held.origin)));
    }
    const taken: Array<readonly [Digest, JarOrigin]> = [];
    for (const held of reads) {
      const id = digests.originId(held.origin);
      const kept = contents.origins.get(id);
      const view = hostView(a, kept ?? { storage: emptyStorage(held.origin), indexedDb: false });
      const heldDigest = digests.storageDigest(held);
      a.pending.delete(id);
      a.baseline?.origins.set(id, heldDigest);
      if (heldDigest === digests.storageDigest(view.storage)) continue;
      if (kept === undefined && isEmptyStorage(held)) continue;
      taken.push([id, takeOrigin(kept, held)]);
    }
    yield* change(open, { origins: taken });
    yield* saveBaseline(open, a);
    yield* pushOrigins(open, a, taken);
  });

  /** Reads a host without change events again, and takes what changed. */
  const readAgain = Effect.fn("SignIns.readAgain")(function* (a: Attached) {
    const open = openJar();
    if (open === undefined || !synced(a)) return;
    if (a.cookies) {
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isSome(read) && a.baseline !== undefined)
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
    if (a.storage)
      yield* takeOrigins(
        a,
        [...a.tabs.values()].filter((tab) => !tab.private).map((tab) => tab.url),
      );
  });

  /** Signs out of what `matches` names, in the jar and on every attached host. */
  const signOutOf = Effect.fn("SignIns.signOutOf")(function* (
    signout: BrowserSite,
    matches: (sites: ReadonlyArray<BrowserSite>) => boolean,
  ) {
    const open = openJar();
    if (open === undefined) return;
    const { contents, digests } = open;
    const removed: Array<readonly [Digest, Digest]> = [];
    for (const [id, cookie] of contents.cookies)
      if (matches(sitesOfCookie(cookie))) removed.push([id, digests.cookieDigest(cookie)]);
    const emptied: Array<readonly [Digest, JarOrigin]> = [];
    for (const [id, origin] of contents.origins) {
      const site = siteOfOrigin(origin.storage.origin);
      if (site === undefined || !matches([site]) || isEmptyStorage(origin.storage)) continue;
      const empty = emptyStorage(origin.storage.origin);
      emptied.push([
        id,
        {
          indexedDb: origin.indexedDb,
          storage: origin.indexedDb ? { ...empty, indexedDb: [] } : empty,
        },
      ]);
    }
    yield* change(open, {
      cookies: { set: [], removed },
      origins: emptied,
      signouts: [[digests.siteId(signout), contents.version + 1]],
    });
    for (const a of attached) {
      if (!a.cookies || !synced(a)) continue;
      // What the host holds, not only what the jar knew: a change on its
      // way to the jar is signed out of too.
      const read = yield* hostCall("give its cookies", a.host.readCookies);
      if (Option.isNone(read)) {
        yield* broke(open, a);
        continue;
      }
      const gone = read.value.cookies.filter((cookie) => matches(sitesOfCookie(cookie)));
      if (gone.length > 0) {
        const written = yield* hostCall(
          "take cookies",
          a.host.writeCookies({ set: [], removed: gone.map(keyOfCookie) }),
        );
        if (Option.isNone(written)) {
          yield* broke(open, a);
          continue;
        }
      }
      for (const cookie of gone) a.baseline?.cookies.delete(digests.cookieId(keyOfCookie(cookie)));
      yield* saveBaseline(open, a);
    }
    yield* pushOrigins(open, undefined, emptied);
  });

  const attach = Effect.fn("SignIns.attach")(function* (host: PageHost, hello: BrowserHostHello) {
    const { capabilities } = hello;
    const digests = jar._tag === "keyless" ? undefined : jar.digests;
    const a: Attached = {
      host,
      scope: yield* Effect.scope,
      store:
        hello.cookieStore === undefined || digests === undefined
          ? undefined
          : digests.storeId(hello.cookieStore),
      cookies: capabilities.cookies === true,
      storage: capabilities.storage === true,
      indexedDb: capabilities.indexedDb === true,
      events: capabilities.changeEvents === true,
      baseline: undefined,
      since: undefined,
      pending: new Set(),
      fresh: true,
      tabs: new Map(hello.tabs.map((page) => [page.tab, { url: page.url, private: false }])),
      broken: false,
    };
    const idle: SignInsAttachment = {
      event: () => Effect.void,
      flush: Effect.void,
      prepare: () => Effect.void,
    };
    if (!a.cookies && !a.storage) return idle;
    yield* Effect.acquireRelease(
      Effect.sync(() => attached.add(a)),
      () => Effect.sync(() => attached.delete(a)),
    );
    yield* locked(reconcile(a));

    const reads = yield* Queue.sliding<void>(1);
    if (!a.events) {
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(reads).pipe(
            Effect.andThen(Effect.sleep(READ_AFTER_LOAD_MS)),
            Effect.andThen(locked(readAgain(a))),
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

    const event = (incoming: BrowserHostEvent): Effect.Effect<void> => {
      switch (incoming.type) {
        case "tab.opened":
          a.tabs.set(incoming.page.tab, { url: incoming.page.url, private: incoming.private });
          return Effect.void;
        case "tab.changed": {
          const tab = a.tabs.get(incoming.page.tab);
          if (tab === undefined)
            a.tabs.set(incoming.page.tab, { url: incoming.page.url, private: false });
          else tab.url = incoming.page.url;
          return tab?.private === true || incoming.page.loading ? Effect.void : readSoon;
        }
        case "tab.closed":
          return a.tabs.delete(incoming.tab) ? readSoon : Effect.void;
        case "cookies.changed":
          return locked(takeCookies(a, incoming.changes));
        case "storage.changed":
          return locked(takeOrigins(a, incoming.origins));
        case "tab.focused":
        case "person.input":
        case "pointer":
          return Effect.void;
      }
    };
    const prepare = (url: string) =>
      Effect.suspend(() => {
        const origin = originOf(url);
        if (origin === undefined || digests === undefined) return Effect.void;
        return locked(syncOrigin(a, digests.originId(origin))).pipe(
          Effect.timeout(PREPARE_MS),
          Effect.ignore,
        );
      });
    return {
      event,
      flush: a.events ? Effect.void : locked(readAgain(a)),
      prepare,
    } satisfies SignInsAttachment;
  });

  const signOutSite = (site: BrowserSite) =>
    locked(signOutOf(site, (sites) => sites.includes(site)));

  const signOut = locked(
    Effect.gen(function* () {
      if (jar._tag === "keyless") return yield* new Conflict({ reason: "secrets-unavailable" });
      if (jar._tag === "open") return yield* signOutOf(ALL_SITES, () => true);
      yield* jar.file.reset;
      jar = { _tag: "open", file: jar.file, digests: jar.digests, contents: emptyContents() };
      yield* publish;
      // Hosts that attached while the jar was unreadable: nothing of theirs
      // was synced, and every cookie they hold goes now.
      for (const a of attached) {
        if (a.cookies) {
          const read = yield* hostCall("give its cookies", a.host.readCookies);
          if (Option.isSome(read) && read.value.cookies.length > 0)
            yield* hostCall(
              "take cookies",
              a.host.writeCookies({ set: [], removed: read.value.cookies.map(keyOfCookie) }),
            );
        }
        yield* reconcile(a);
      }
    }),
  );

  const toBringIn = Effect.sync(() => jar._tag === "open" && !jar.contents.migrated);

  const bringIn = (input: {
    readonly cookies: ReadonlyArray<BrowserCookie>;
    readonly origins: ReadonlyArray<JarOrigin>;
  }) =>
    locked(
      Effect.gen(function* () {
        const open = openJar();
        if (open === undefined || open.contents.migrated) return;
        const { contents, digests } = open;
        const plan = reconcileCookies({
          jar: contents.cookies,
          tombstones: contents.tombstones,
          baseline: undefined,
          revoked: () => false,
          host: input.cookies,
          now: yield* Clock.currentTimeMillis,
          digests,
        });
        const origins: Array<readonly [Digest, JarOrigin]> = [];
        for (const origin of input.origins) {
          if (originOf(origin.storage.origin) === undefined || isEmptyStorage(origin.storage))
            continue;
          const id = digests.originId(origin.storage.origin);
          const kept = contents.origins.get(id);
          if (kept === undefined || isEmptyStorage(kept.storage)) origins.push([id, origin]);
        }
        const cookies: JarCookieChanges = { set: plan.jar.set, removed: [] };
        yield* change(open, { cookies, origins, migrated: true });
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
 * jar unreadable, and its file untouched.
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
