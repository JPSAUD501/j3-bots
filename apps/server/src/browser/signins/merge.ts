// SPDX-License-Identifier: AGPL-3.0-or-later
import { Buffer } from "node:buffer";
import type {
  BrowserCookie,
  BrowserCookieChanges,
  BrowserCookieKey,
  BrowserIndexedDb,
  BrowserOriginStorage,
} from "@j3-bots/contracts";
import { type Digest, type Digests, expiredAt, keyOfCookie, normalCookie } from "./canonical.ts";

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
//
// An origin's `localStorage` and its databases are brought together apart,
// each against its own digest in the baseline, so a host that changed one
// takes nothing of the other back.

/** A baseline's digest for an origin the host was new to: brought together as by a new host. */
const UNKNOWN: Digest = "";

/**
 * What a host held of an origin when it last agreed with the jar: its
 * `localStorage`, and its databases once the two agreed on them.
 */
export interface OriginBaseline {
  readonly local: Digest;
  readonly databases?: Digest;
}

/** An origin the host was new to, as its baseline names it. */
export const UNKNOWN_ORIGIN: OriginBaseline = { local: UNKNOWN };

/** What a host holding `storage` agreed on, its databases included when it has them. */
export const baselineOf = (digests: Digests, storage: BrowserOriginStorage): OriginBaseline => ({
  local: digests.localDigest(storage.origin, storage.localStorage),
  ...(storage.indexedDb === undefined
    ? {}
    : { databases: digests.databasesDigest(storage.origin, storage.indexedDb) }),
});

export const sameBaseline = (a: OriginBaseline | undefined, b: OriginBaseline | undefined) =>
  a?.local === b?.local && a?.databases === b?.databases;

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
  /** What the host takes, as it reads it: its databases only where they go to it. */
  readonly host: BrowserOriginStorage | undefined;
  /** The host's baseline for the origin once it took `host`, or needed nothing. */
  readonly baseline: OriginBaseline;
  /**
   * Its baseline when it wrote nothing of the origin (`waiting`): what it
   * holds of the parts it was to take is still what it held. Undefined:
   * left as it was.
   */
  readonly waiting: OriginBaseline | undefined;
}

/** Which side takes the other's part of an origin: none, when they agree or neither knows. */
type Taker = "neither" | "host" | "jar";

/**
 * Brings one origin's storage on a host and in the jar together, as
 * `reconcileCookies` does a host's cookies, its `localStorage` and its
 * databases each on its own. `read` is the host's, with its databases when
 * the host read them. `baseline` is the host's for the origin: undefined
 * when the host has a baseline without the origin, which held nothing then;
 * `none` when the host has no baseline for it at all.
 *
 * - `localStorage`: what the host changed since its baseline goes to the
 *   jar, unless the site was signed out of since; otherwise the jar's goes
 *   to the host. With no baseline, the jar's wins unless it is empty.
 * - Databases, when the host read them: the jar takes them first from a
 *   host that has some, an empty read teaching it nothing. Once both have
 *   them, they go three ways as `localStorage` does, against the databases
 *   the host last agreed on; with none agreed yet, the jar's win unless the
 *   jar has none. The jar takes no more than `room` bytes of them: more
 *   makes the origin `tooBig`, and the jar drops what it kept of them.
 */
export const reconcileOrigin = (input: {
  readonly kept: JarOrigin | undefined;
  readonly read: BrowserOriginStorage;
  readonly room: number;
  readonly baseline: OriginBaseline | undefined | "none";
  readonly revoked: boolean;
  readonly digests: Digests;
}): OriginReconcile => {
  const { kept, read, room, revoked, digests } = input;
  const origin = read.origin;
  // A baseline without the origin held nothing, databases included.
  const baseline =
    input.baseline === "none" || input.baseline?.local === UNKNOWN
      ? "none"
      : (input.baseline ??
        baselineOf(digests, {
          origin,
          localStorage: [],
          ...(read.indexedDb ? { indexedDb: [] } : {}),
        }));

  const keptLocal = kept?.storage.localStorage ?? [];
  const heldLocal = digests.localDigest(origin, read.localStorage);
  const jarLocal = digests.localDigest(origin, keptLocal);
  const localTaker = ((): Taker => {
    if (heldLocal === jarLocal) return "neither";
    if (baseline === "none") return keptLocal.length === 0 ? "jar" : "host";
    return heldLocal === baseline.local || revoked ? "host" : "jar";
  })();

  const hostDatabases = read.indexedDb;
  const jarDatabases = kept?.tooBig === true ? undefined : kept?.storage.indexedDb;
  const heldDatabases =
    hostDatabases === undefined ? undefined : digests.databasesDigest(origin, hostDatabases);
  const databasesTaker = ((): Taker => {
    if (hostDatabases === undefined || kept?.tooBig === true) return "neither";
    if (jarDatabases === undefined) return hostDatabases.length > 0 ? "jar" : "neither";
    if (heldDatabases === digests.databasesDigest(origin, jarDatabases)) return "neither";
    const was = baseline === "none" ? undefined : baseline.databases;
    if (was === undefined) return jarDatabases.length === 0 ? "jar" : "host";
    return heldDatabases === was || revoked ? "host" : "jar";
  })();
  const tooBig =
    kept?.tooBig === true || (databasesTaker === "jar" && databaseBytes(hostDatabases) > room);
  const takesDatabases = databasesTaker === "jar" && !tooBig;
  const givesDatabases = databasesTaker === "host";

  const databasesAfter = tooBig ? undefined : takesDatabases ? hostDatabases : jarDatabases;
  const jar: JarOrigin | undefined =
    localTaker === "jar" || databasesTaker === "jar"
      ? {
          storage: {
            origin,
            localStorage: localTaker === "jar" ? read.localStorage : keptLocal,
            ...(databasesAfter === undefined ? {} : { indexedDb: databasesAfter }),
          },
          ...(tooBig ? { tooBig: true } : {}),
        }
      : undefined;
  const host: BrowserOriginStorage | undefined =
    localTaker === "host" || givesDatabases
      ? {
          origin,
          localStorage: localTaker === "host" ? keptLocal : read.localStorage,
          ...(givesDatabases && jarDatabases !== undefined ? { indexedDb: jarDatabases } : {}),
        }
      : undefined;

  // The host and the jar agree on its databases once the jar keeps them and
  // the host holds the same.
  const hostDatabasesAfter = givesDatabases ? jarDatabases : hostDatabases;
  const agreedDatabases =
    databasesAfter !== undefined &&
    hostDatabasesAfter !== undefined &&
    digests.databasesDigest(origin, databasesAfter) ===
      digests.databasesDigest(origin, hostDatabasesAfter)
      ? digests.databasesDigest(origin, databasesAfter)
      : undefined;
  const after: OriginBaseline = {
    local: localTaker === "host" ? jarLocal : heldLocal,
    ...(agreedDatabases === undefined ? {} : { databases: agreedDatabases }),
  };
  const was = baseline === "none" ? undefined : baseline;
  const whileWaiting = (): OriginBaseline | undefined => {
    if (was === undefined) return undefined;
    const databases = givesDatabases ? was.databases : after.databases;
    return {
      local: localTaker === "host" ? was.local : heldLocal,
      ...(databases === undefined ? {} : { databases }),
    };
  };
  return { jar, host, baseline: after, waiting: whileWaiting() };
};
