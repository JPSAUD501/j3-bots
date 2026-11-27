// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReleaseNumber, WhatsNewRelease } from "@j3-bots/i18n/whats-new";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Cell, type Readable } from "../Store.ts";
import type { ServerUpdateView } from "../update/ServerUpdate.ts";

// "What's new", the same on every client: the releases whose entries the
// operator can read, up to the one their server runs, and the mark that
// points to them once after an update, until opened. It follows the server's
// version as this device last saw it, kept on the device, since the server
// is what an update brings the features to; each platform supplies where.

/** What a device keeps: the server's version it last saw, and the newest release it opened. */
export interface WhatsNewSeen {
  readonly server: string | null;
  readonly opened: ReleaseNumber | null;
}

/** Where a device keeps `WhatsNewSeen`; a store that fails keeps it for this launch only. */
export interface WhatsNewStore {
  readonly read: () => WhatsNewSeen;
  readonly write: (seen: WhatsNewSeen) => void;
}

const NONE_SEEN: WhatsNewSeen = { server: null, opened: null };

const SeenJson = Schema.fromJsonString(
  Schema.Struct({
    server: Schema.NullOr(Schema.String),
    opened: Schema.NullOr(
      Schema.TemplateLiteral([Schema.Number, ".", Schema.Number, ".", Schema.Number]),
    ),
  }),
);
const decodeSeen = Schema.decodeUnknownOption(SeenJson);
const encodeSeen = Schema.encodeSync(SeenJson);

/**
 * A `WhatsNewStore` over a platform's string storage: `get` and `set` may
 * throw, as a browser's storage does when it is refused, and what they keep
 * may be anything; either reads as nothing seen.
 */
export const whatsNewStore = (storage: {
  readonly get: () => string | null;
  readonly set: (value: string) => void;
}): WhatsNewStore => ({
  read: () => {
    try {
      return Option.getOrElse(decodeSeen(storage.get()), () => NONE_SEEN);
    } catch {
      return NONE_SEEN;
    }
  },
  write: (seen) => {
    try {
      storage.set(encodeSeen(seen));
    } catch {
      // Kept for this launch only.
    }
  },
});

export interface WhatsNewView {
  /** The releases up to the server's, newest first. Empty: there is nothing to show, and no place for it. */
  readonly releases: ReadonlyArray<WhatsNewRelease>;
  /** The release the mark names until What's new is opened; null for no mark. */
  readonly mark: ReleaseNumber | null;
}

/** `x.y.z` of a version, whatever its pre-release: a candidate or a nightly leads to it. */
const numbersOf = (version: string): readonly [number, number, number] | null => {
  const found = /^(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(version);
  return found === null ? null : [Number(found[1]), Number(found[2]), Number(found[3])];
};

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
const compare = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * What a device shows: the releases no newer than the server it last saw,
 * and a mark for the newest of them unless it was opened. A device that
 * never opened What's new has the mark too, the first time there is anything.
 */
const whatsNewView = (
  catalog: ReadonlyArray<WhatsNewRelease>,
  seen: WhatsNewSeen,
): WhatsNewView => {
  const server = seen.server === null ? null : numbersOf(seen.server);
  if (server === null) return { releases: [], mark: null };
  const releases = catalog
    .flatMap((release) => {
      const numbers = numbersOf(release.version);
      return numbers !== null && compare(numbers, server) <= 0 ? [{ release, numbers }] : [];
    })
    .sort((a, b) => compare(b.numbers, a.numbers));
  const newest = releases[0];
  const opened = seen.opened === null ? null : numbersOf(seen.opened);
  return {
    releases: releases.map(({ release }) => release),
    mark:
      newest !== undefined && (opened === null || compare(newest.numbers, opened) > 0)
        ? newest.release.version
        : null,
  };
};

/** A release as the mark names it: `0.14` for `0.14.0`, `0.14.1` as it is. */
export const releaseName = (version: ReleaseNumber): string => version.replace(/\.0$/, "");

/** The version the server runs, as this client last read it; null before it read one. */
const runningVersion = (view: ServerUpdateView): string | null => {
  switch (view._tag) {
    case "unread":
      return null;
    case "unreachable":
      return view.last?.current.version ?? null;
    case "status":
      return view.status.current.version;
    case "restarting":
    case "lost":
      return view.last.current.version;
  }
};

export interface WhatsNew {
  readonly view: Readable<WhatsNewView>;
  /** The operator opened What's new: the mark goes until a newer release with entries reaches them. */
  readonly open: () => void;
}

export interface WhatsNewDeps {
  /** The server's updates as this client reads them, which say the version it runs. */
  readonly server: Readable<ServerUpdateView>;
  readonly store: WhatsNewStore;
  readonly catalog: ReadonlyArray<WhatsNewRelease>;
}

export const makeWhatsNew = (deps: WhatsNewDeps): WhatsNew => {
  let seen = deps.store.read();
  const view = new Cell(whatsNewView(deps.catalog, seen));
  const keep = (next: WhatsNewSeen): void => {
    seen = next;
    deps.store.write(next);
    view.set(whatsNewView(deps.catalog, next));
  };
  const follow = (): void => {
    const server = runningVersion(deps.server.get());
    if (server !== null && server !== seen.server) keep({ ...seen, server });
  };
  deps.server.subscribe(follow);
  follow();
  return {
    view,
    open: () => {
      const mark = view.get().mark;
      if (mark !== null) keep({ ...seen, opened: mark });
    },
  };
};
