// SPDX-License-Identifier: AGPL-3.0-or-later
import { Buffer } from "node:buffer";
import type {
  BrowserCookie,
  BrowserCookieChanges,
  BrowserCookieKey,
  BrowserIndexedDb,
  BrowserOriginStorage,
} from "@j3-bots/contracts";
import {
  type Digest,
  type Digests,
  emptyStorage,
  expiredAt,
  isEmptyStorage,
  keyOfCookie,
  normalCookie,
  storageView,
} from "./canonical.ts";

// How the shared sign-ins and one host's store come to agree
// (`docs/architecture/server.md`, "Sign-ins"). Nothing here reads or writes
// anything: each function plans what the jar and the host take, and
// `SignIns.ts` carries it out.
//
// A host's baseline is what it held, by digest, when it last agreed with
// the jar, and its version is the jar's up to which every sign-out reached
// the host. With one, a cookie the host changed since and the jar did not is
// the host's to give; one the jar changed and the host did not is the
// jar's; one both changed is the host's, the last change received, unless
// its site was signed out since, which wins. A host without a baseline is
// new to the jar: what it holds and the jar does not is added, what both
// hold differently is the jar's, and nothing is removed from either, but a
// cookie the jar removed with the same value is not brought back. An origin
// a host's baseline names as `UNKNOWN` was the jar's when the host was new,
// and is still to be brought together so.

/** A baseline's digest for an origin the host was new to: brought together as by a new host. */
export const UNKNOWN: Digest = "";

/** The jar's cookies, by id. */
export type JarCookies = ReadonlyMap<Digest, BrowserCookie>;

/** What a baseline holds of one kind: digests by id. */
export type BaselineEntries = ReadonlyMap<Digest, Digest>;

/** Cookies the jar takes. */
export interface JarCookieChanges {
  readonly set: ReadonlyArray<readonly [Digest, BrowserCookie]>;
  /** Removed, with the digest of what was removed, which a tombstone keeps. */
  readonly removed: ReadonlyArray<readonly [Digest, Digest]>;
}

export const hasCookieChanges = (changes: BrowserCookieChanges) =>
  changes.set.length > 0 || changes.removed.length > 0;

/** What reconciling a host's cookies with the jar gives. */
export interface CookieReconcile {
  readonly jar: JarCookieChanges;
  /** What the host takes. */
  readonly host: BrowserCookieChanges;
  /** The host's baseline afterwards: the jar's cookies, as the host now holds them. */
  readonly baseline: BaselineEntries;
}

/**
 * Brings a host's cookies and the jar's together, when a host attaches.
 *
 * - `baseline`: the host's, when it has one for this store.
 * - `revoked`: whether the person signed out of a cookie's site since the
 *   baseline.
 * - `tombstones`: the digest each cookie the jar removed had.
 * - `restarted`: whether the host's browser started again since the
 *   baseline, or cannot say.
 *
 * After a restart, a session cookie the jar holds and the host does not was
 * lost to the restart, never removed, whatever value the host last had: the
 * jar keeps it and the host gets it back. In the same run of its browser, a
 * cookie the host no longer holds was removed by its site. Expired cookies
 * leave the jar, and are no host's to give.
 */
export const reconcileCookies = (input: {
  readonly jar: JarCookies;
  readonly tombstones: ReadonlyMap<Digest, Digest>;
  readonly baseline: BaselineEntries | undefined;
  readonly restarted: boolean;
  readonly revoked: (cookie: BrowserCookie) => boolean;
  readonly host: ReadonlyArray<BrowserCookie>;
  readonly now: number;
  readonly digests: Digests;
}): CookieReconcile => {
  const { jar, tombstones, baseline, restarted, revoked, now, digests } = input;
  const host = new Map<Digest, BrowserCookie>();
  for (const cookie of input.host) {
    const normal = normalCookie(cookie);
    if (!expiredAt(normal, now)) host.set(digests.cookieId(keyOfCookie(normal)), normal);
  }
  const jarSet: Array<readonly [Digest, BrowserCookie]> = [];
  const jarRemoved: Array<readonly [Digest, Digest]> = [];
  const hostSet: Array<BrowserCookie> = [];
  const hostRemoved: Array<BrowserCookieKey> = [];
  const next = new Map<Digest, Digest>();

  const ids = new Set([...host.keys(), ...jar.keys(), ...(baseline?.keys() ?? [])]);
  for (const id of ids) {
    const held = host.get(id);
    const kept = jar.get(id);
    const live = kept === undefined || expiredAt(kept, now) ? undefined : kept;
    const heldDigest = held === undefined ? undefined : digests.cookieDigest(held);
    const keptDigest = live === undefined ? undefined : digests.cookieDigest(live);

    let target: BrowserCookie | undefined;
    if (baseline === undefined) {
      if (live !== undefined) target = live;
      else if (held !== undefined && tombstones.get(id) !== heldDigest) target = held;
      else target = undefined;
    } else {
      const was = baseline.get(id);
      const lostToRestart =
        restarted && held === undefined && live !== undefined && live.expires === undefined;
      const hostChanged = !lostToRestart && heldDigest !== was;
      const site = held ?? live;
      if (!hostChanged) target = live;
      else target = site !== undefined && revoked(site) ? live : held;
    }

    const targetDigest = target === undefined ? undefined : digests.cookieDigest(target);
    if (targetDigest !== keptDigest || (kept !== undefined && live === undefined)) {
      if (target === undefined) {
        if (kept !== undefined) jarRemoved.push([id, digests.cookieDigest(kept)]);
      } else jarSet.push([id, target]);
    }
    if (targetDigest !== heldDigest) {
      if (target === undefined) {
        if (held !== undefined) hostRemoved.push(keyOfCookie(held));
      } else hostSet.push(target);
    }
    if (target !== undefined && targetDigest !== undefined) next.set(id, targetDigest);
  }
  return {
    jar: { set: jarSet, removed: jarRemoved },
    host: { set: hostSet, removed: hostRemoved },
    baseline: next,
  };
};

/**
 * What the jar takes of cookies a host reports changed. A batch that removes
 * a cookie and sets it again sets it; a cookie set as the jar already holds
 * it, as a write of the jar's own coming back, changes nothing.
 */
export const takeHostCookies = (input: {
  readonly jar: JarCookies;
  readonly changes: BrowserCookieChanges;
  readonly now: number;
  readonly digests: Digests;
}): {
  readonly jar: JarCookieChanges;
  /** What every other host takes. */
  readonly others: BrowserCookieChanges;
  /** The reporting host's baseline: set, and removed (undefined). */
  readonly baseline: ReadonlyMap<Digest, Digest | undefined>;
} => {
  const { jar, now, digests } = input;
  const set = new Map<Digest, BrowserCookie>();
  for (const cookie of input.changes.set) {
    const normal = normalCookie(cookie);
    set.set(digests.cookieId(keyOfCookie(normal)), normal);
  }
  const removed = new Set<Digest>();
  for (const key of input.changes.removed) {
    const id = digests.cookieId(key);
    if (!set.has(id)) removed.add(id);
  }
  const jarSet: Array<readonly [Digest, BrowserCookie]> = [];
  const jarRemoved: Array<readonly [Digest, Digest]> = [];
  const others: { set: Array<BrowserCookie>; removed: Array<BrowserCookieKey> } = {
    set: [],
    removed: [],
  };
  const baseline = new Map<Digest, Digest | undefined>();
  const remove = (id: Digest) => {
    baseline.set(id, undefined);
    const kept = jar.get(id);
    if (kept === undefined) return;
    jarRemoved.push([id, digests.cookieDigest(kept)]);
    others.removed.push(keyOfCookie(kept));
  };
  for (const id of removed) remove(id);
  for (const [id, cookie] of set) {
    if (expiredAt(cookie, now)) {
      remove(id);
      continue;
    }
    const digest = digests.cookieDigest(cookie);
    baseline.set(id, digest);
    const kept = jar.get(id);
    if (kept !== undefined && digests.cookieDigest(kept) === digest) continue;
    jarSet.push([id, cookie]);
    others.set.push(cookie);
  }
  return { jar: { set: jarSet, removed: jarRemoved }, others, baseline };
};

/**
 * What a host without change events changed since `baseline`, from what it
 * holds now: cookies whose value differs from the baseline's, and cookies
 * the baseline had that it holds no longer.
 */
export const diffHostCookies = (input: {
  readonly baseline: BaselineEntries;
  readonly host: ReadonlyArray<BrowserCookie>;
  readonly jar: JarCookies;
  readonly digests: Digests;
}): BrowserCookieChanges => {
  const { baseline, jar, digests } = input;
  const held = new Set<Digest>();
  const set: Array<BrowserCookie> = [];
  for (const cookie of input.host) {
    const normal = normalCookie(cookie);
    const id = digests.cookieId(keyOfCookie(normal));
    held.add(id);
    if (baseline.get(id) !== digests.cookieDigest(normal)) set.push(normal);
  }
  const removed: Array<BrowserCookieKey> = [];
  for (const id of baseline.keys()) {
    if (held.has(id)) continue;
    const kept = jar.get(id);
    if (kept !== undefined) removed.push(keyOfCookie(kept));
  }
  return { set, removed };
};

/**
 * One origin the jar keeps. Its storage has `indexedDb` once the jar keeps
 * the origin's databases: from when a host that reads databases first read
 * them, if they fit the room the jar has for them. An origin whose databases
 * did not is `tooBig`: the jar keeps none of its databases, and asks no host
 * for them, until the site is signed out of.
 */
export interface JarOrigin {
  readonly storage: BrowserOriginStorage;
  readonly tooBig?: true;
}

/** How many bytes an origin's databases take, encoded as the jar keeps them. */
export const databaseBytes = (databases: ReadonlyArray<BrowserIndexedDb> | undefined) =>
  databases === undefined ? 0 : Buffer.byteLength(JSON.stringify(databases), "utf8");

/** What reconciling one origin's storage gives. */
export interface OriginReconcile {
  readonly jar: JarOrigin | undefined;
  /** What the host takes, as it reads it. */
  readonly host: BrowserOriginStorage | undefined;
  /** The digest the host's baseline keeps for the origin afterwards. */
  readonly baseline: Digest;
}

/**
 * Brings one origin's storage on a host and in the jar together, as
 * `reconcileCookies` does a host's cookies. `read` is the host's, with its
 * databases when the host read them. `baseline` is the host's digest for
 * the origin: undefined when the host has a baseline without the origin,
 * which held nothing then; `none` when the host has no baseline at all.
 *
 * The databases are compared only when both sides have them. The jar takes
 * the host's along with its `localStorage`, and takes them anyway when it
 * kept none of the origin's yet, as long as they take no more than `room`
 * bytes; databases that take more make the origin `tooBig`, and the jar
 * drops what it kept of them.
 */
export const reconcileOrigin = (input: {
  readonly kept: JarOrigin | undefined;
  readonly read: BrowserOriginStorage;
  readonly room: number;
  readonly baseline: Digest | undefined | "none";
  readonly revoked: boolean;
  readonly digests: Digests;
}): OriginReconcile => {
  const { kept, read, room, baseline, revoked, digests } = input;
  const known = kept?.storage.indexedDb !== undefined;
  const readsDatabases = read.indexedDb !== undefined;
  const both = known && readsDatabases;
  const view = storageView(kept?.storage ?? emptyStorage(read.origin), both);
  const heldDigest = digests.storageDigest(storageView(read, both));
  const keptDigest = digests.storageDigest(view);
  /** Which side takes the other's storage. */
  const taker = ((): "neither" | "host" | "jar" => {
    if (heldDigest === keptDigest) return "neither";
    if (baseline === "none") return isEmptyStorage(view) ? "jar" : "host";
    const was = baseline ?? digests.storageDigest(storageView(emptyStorage(read.origin), both));
    // A baseline taken before the jar kept the origin's databases names its
    // `localStorage` alone.
    const unchanged =
      heldDigest === was || (both && digests.storageDigest(storageView(read, false)) === was);
    return unchanged || revoked ? "host" : "jar";
  })();

  const offered =
    readsDatabases && kept?.tooBig !== true && (taker === "jar" || !known)
      ? read.indexedDb
      : undefined;
  const tooBig = kept?.tooBig === true || (offered !== undefined && databaseBytes(offered) > room);
  const databases = tooBig ? undefined : (offered ?? kept?.storage.indexedDb);
  const jar: JarOrigin | undefined =
    taker === "jar" || offered !== undefined
      ? {
          storage: {
            origin: read.origin,
            localStorage: taker === "jar" ? read.localStorage : (kept?.storage.localStorage ?? []),
            ...(databases === undefined ? {} : { indexedDb: databases }),
          },
          ...(tooBig ? { tooBig: true } : {}),
        }
      : undefined;

  // What the host holds afterwards, as it will be compared next time.
  const hostDatabases = taker === "host" && both ? view.indexedDb : read.indexedDb;
  const held: BrowserOriginStorage = {
    origin: read.origin,
    localStorage: taker === "host" ? view.localStorage : read.localStorage,
    ...(hostDatabases === undefined ? {} : { indexedDb: hostDatabases }),
  };
  return {
    jar,
    host: taker === "host" ? view : undefined,
    baseline: digests.storageDigest(storageView(held, databases !== undefined && readsDatabases)),
  };
};
