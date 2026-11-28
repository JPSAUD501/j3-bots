// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type BrowserCookie,
  BrowserIndexedDb,
  type BrowserOriginStorage,
} from "@j3-bots/contracts";
import { platformErrorCode, whileHeld } from "@j3-bots/processes";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlSchema from "effect/sql/SqlSchema";
import { chromium } from "playwright-core";
import { cookieOfCdp } from "./cookies.ts";
import { logKeys, tableKeys } from "./leveldb.ts";

// The sign-ins a Chromium profile on the disk holds: its cookies, and the
// storage and databases of the sites it was used on. For the one move of the
// engine's browser's sign-ins into J3 Bots' own, once (decision 0110).
//
// - Only what the move needs is copied, into a working folder the caller
//   gives: the cookies, the history, the sites' storage and databases, and
//   the preferences. No cache and no service worker comes along, and the
//   profile itself is never changed.
// - The origins whose storage it kept are found in the copy's own files
//   before the browser opens it: `localStorage`'s keys, the databases'
//   folders, and the storage keys of the quota database. A browser that
//   keeps no history, as `chrome-headless-shell` does not, still has each
//   read. One of those that cannot be read fails the whole read, so the
//   profile is kept.
// - The copy is opened by the Chromium that wrote it, or a newer one, with
//   every request it makes answered by an empty page here, and the network
//   off underneath: a proxy nothing answers at, and no name resolves.

export interface ProfileSignIns {
  readonly cookies: ReadonlyArray<BrowserCookie>;
  /** Each origin's storage, with every database it kept: none is `[]`. */
  readonly origins: ReadonlyArray<BrowserOriginStorage>;
  /**
   * The origins the profile showed as pages, as its history or its sites'
   * own storage say: not its cookies' domains, which pages of other sites set.
   */
  readonly visited: ReadonlyArray<string>;
}

/** The profile could not be read; nothing of it was taken. */
export class ProfileUnreadable extends Schema.TaggedError<ProfileUnreadable>()(
  "ProfileUnreadable",
  { detail: Schema.String },
) {}

/** The most origins of the profile's history read: the latest visited. */
const MOST_HISTORY_ORIGINS = 300;
/** How long a page at one origin may take to open, routed to an empty page. */
const ORIGIN_MS = 5_000;

/** What the copy takes of the profile, where it exists: files, and folders whole. */
const COPIED = [
  "Local State",
  "Default/Preferences",
  "Default/Cookies",
  "Default/Cookies-journal",
  "Default/Network",
  "Default/History",
  "Default/History-journal",
  "Default/Local Storage",
  "Default/IndexedDB",
  "Default/WebStorage",
];

/**
 * The network, off for the browser that reads the copy: a proxy at a port
 * nothing listens at, the loopback included, and no name that resolves.
 * Requests the pages make are answered before either, by the route.
 */
const OFFLINE = {
  proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
  args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
};

const StorageState = Schema.Struct({
  origins: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      indexedDB: Schema.optionalKey(Schema.Array(BrowserIndexedDb)),
    }),
  ),
});
const decodeStorageState = Schema.decodeUnknownEffect(StorageState);
const CookiesResult = Schema.Struct({ cookies: Schema.Array(Schema.Unknown) });
const decodeCookies = Schema.decodeUnknownEffect(CookiesResult);

/** An address's origin, for http and https alone. */
const webOrigin = (url: string): Option.Option<string> => {
  if (!URL.canParse(url)) return Option.none();
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? Option.some(parsed.origin)
    : Option.none();
};

/** `text` when it is an http or https origin and nothing more: not a partitioned key. */
const plainOrigin = (text: string): Option.Option<string> =>
  Option.filter(webOrigin(text), (origin) => origin === text);

const unreadable = (detail: string) => () => new ProfileUnreadable({ detail });

/** The origins the profile's history visited, the latest first. */
const historyOrigins = Effect.fn("profile.historyOrigins")(function* (history: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(history))) return [];
  const sql = yield* SqliteClient.make({ filename: history, readonly: true });
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ url: Schema.String }),
    execute: () => sql`SELECT url FROM urls ORDER BY last_visit_time DESC LIMIT 5000`,
  })(undefined);
  const origins = new Set<string>();
  for (const { url } of rows) {
    Option.map(webOrigin(url), (origin) => origins.add(origin));
    if (origins.size >= MOST_HISTORY_ORIGINS) break;
  }
  return [...origins];
}, Effect.provide(Reactivity.layer));

/** The keys of the LevelDB database in `folder`, set or deleted; none when there is none. */
const levelDbKeys = Effect.fn("profile.levelDbKeys")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(folder))) return [];
  const keys: Array<Uint8Array> = [];
  for (const name of yield* fs.readDirectory(folder)) {
    if (/^\d+\.log$/.test(name)) keys.push(...logKeys(yield* fs.readFile(path.join(folder, name))));
    else if (/^\d+\.(ldb|sst)$/.test(name)) {
      const table = tableKeys(yield* fs.readFile(path.join(folder, name)));
      if (table === undefined)
        return yield* new ProfileUnreadable({
          detail: "A table of the sites' storage did not read.",
        });
      keys.push(...table);
    }
  }
  return keys;
});

/**
 * The origins `localStorage` kept: Chromium's keys are `META:<origin>` for
 * each, and `_<origin>` then a zero byte for each of its items.
 */
const localStorageOrigins = (keys: ReadonlyArray<Uint8Array>): ReadonlyArray<string> =>
  keys.flatMap((key) => {
    const text = Buffer.from(key).toString("latin1");
    const origin = text.startsWith("META:")
      ? text.slice("META:".length)
      : text.startsWith("_") && text.includes("\u0000")
        ? text.slice(1, text.indexOf("\u0000"))
        : undefined;
    return origin === undefined ? [] : Option.toArray(plainOrigin(origin));
  });

/** The origin a database folder of the older layout is named for: `https_host_0.indexeddb.leveldb`. */
const indexedDbFolderOrigin = (name: string): Option.Option<string> => {
  const match = /^([a-z]+)_(.+)_(\d+)\.indexeddb\.leveldb$/.exec(name);
  if (match === null) return Option.none();
  const [, scheme, host, port] = match;
  return plainOrigin(port === "0" ? `${scheme}://${host}` : `${scheme}://${host}:${port}`);
};

/** The storage keys the quota database lists, for the newer layout of databases. */
const quotaOrigins = Effect.fn("profile.quotaOrigins")(function* (quota: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(quota))) return [];
  const sql = yield* SqliteClient.make({ filename: quota, readonly: true });
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ storage_key: Schema.String }),
    execute: () => sql`SELECT DISTINCT storage_key FROM buckets`,
  })(undefined);
  return rows.flatMap(({ storage_key: key }) =>
    key.endsWith("/") ? Option.toArray(plainOrigin(key.slice(0, -1))) : [],
  );
}, Effect.provide(Reactivity.layer));

/** The origins whose storage the copy at `copy` kept, from its own files. */
const storageOrigins = Effect.fn("profile.storageOrigins")(function* (copy: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const origins = new Set(
    localStorageOrigins(yield* levelDbKeys(path.join(copy, "Default", "Local Storage", "leveldb"))),
  );
  const databases = path.join(copy, "Default", "IndexedDB");
  if (yield* fs.exists(databases))
    for (const name of yield* fs.readDirectory(databases))
      Option.map(indexedDbFolderOrigin(name), (origin) => origins.add(origin));
  for (const origin of yield* quotaOrigins(
    path.join(copy, "Default", "WebStorage", "QuotaManager"),
  ))
    origins.add(origin);
  return [...origins];
});

/** Copies what the move needs of `profile` into `copy`, which is empty. */
const copyNeeded = Effect.fn("profile.copyNeeded")(function* (profile: string, copy: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of COPIED) {
    const from = path.join(profile, ...entry.split("/"));
    // Only an entry that is not there is skipped: any other failure ends
    // the read, before the move commits or deletes anything.
    const info = yield* fs.stat(from).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(info)) continue;
    const to = path.join(copy, ...entry.split("/"));
    yield* fs.makeDirectory(path.dirname(to), { recursive: true, mode: 0o700 });
    if (info.value.type === "Directory") yield* fs.copy(from, to);
    else if (info.value.type === "File") yield* fs.copyFile(from, to);
  }
});

/**
 * Reads the sign-ins of the Chromium profile at `profile` with the browser
 * at `executablePath`, from a copy in `workFolder`: emptied first, private
 * to the user, and removed once read, however the read ends.
 */
export const readProfileSignIns = Effect.fn("profile.read")(
  function* (input: {
    readonly profile: string;
    readonly executablePath: string;
    readonly workFolder: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const copy = input.workFolder;
    // Released last, once the browser and every database of the copy closed:
    // Windows may still hold a file of it a moment after.
    const removeCopy = whileHeld(fs.remove(copy, { recursive: true, force: true }), {
      platform: process.platform,
      codeOf: platformErrorCode,
    });
    yield* Effect.acquireRelease(
      removeCopy.pipe(
        Effect.andThen(fs.makeDirectory(copy, { recursive: true, mode: 0o700 })),
        Effect.andThen(fs.chmod(copy, 0o700)),
      ),
      () => removeCopy.pipe(Effect.ignore),
    );
    yield* copyNeeded(input.profile, copy);

    const stored = yield* storageOrigins(copy).pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(new ProfileUnreadable({ detail: "The databases' list did not read." })),
      ),
    );
    const visited = yield* historyOrigins(path.join(copy, "Default", "History")).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

    const context = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          chromium.launchPersistentContext(copy, {
            executablePath: input.executablePath,
            headless: true,
            serviceWorkers: "block",
            ...OFFLINE,
          }),
        catch: unreadable("The browser did not open the profile."),
      }),
      (opened) => Effect.promise(() => opened.close()),
    );
    const attempt = <A>(detail: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: unreadable(detail) });
    yield* attempt("The profile's pages could not be routed.", () =>
      context.route("**/*", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }),
      ),
    );
    const page = context.pages()[0] ?? (yield* attempt("No page opened.", () => context.newPage()));
    const cdp = yield* attempt("The browser gave no session.", () => context.newCDPSession(page));
    const raw = yield* attempt("The browser gave no cookies.", () =>
      cdp.send("Storage.getCookies"),
    ).pipe(
      Effect.flatMap(decodeCookies),
      Effect.mapError(
        () => new ProfileUnreadable({ detail: "The browser gave cookies in another shape." }),
      ),
    );
    const cookies = raw.cookies.flatMap((cookie) => Option.toArray(cookieOfCdp(cookie)));

    const open = (origin: string) => () =>
      page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: ORIGIN_MS });
    // The browser reads an origin's storage once a page of it opened: one
    // whose storage the copy kept must open, or what it kept would be lost.
    for (const origin of stored)
      yield* attempt("A site whose storage the profile kept did not open.", open(origin));
    const others = new Set(visited);
    for (const cookie of cookies) {
      others.add(`https://${cookie.domain}`);
      if (!cookie.secure) others.add(`http://${cookie.domain}`);
    }
    for (const origin of stored) others.delete(origin);
    for (const origin of others)
      yield* Effect.promise(() =>
        open(origin)().then(
          () => undefined,
          () => undefined,
        ),
      );

    const state = yield* attempt("The browser gave no site storage.", () =>
      context.storageState({ indexedDB: true }),
    ).pipe(
      Effect.flatMap(decodeStorageState),
      Effect.mapError(
        () => new ProfileUnreadable({ detail: "The browser gave site storage in another shape." }),
      ),
    );
    return {
      cookies,
      origins: state.origins.flatMap((origin): ReadonlyArray<BrowserOriginStorage> => {
        const databases = origin.indexedDB ?? [];
        if (origin.localStorage.length === 0 && databases.length === 0) return [];
        return [{ origin: origin.origin, localStorage: origin.localStorage, indexedDb: databases }];
      }),
      visited: [...new Set([...visited, ...stored])],
    } satisfies ProfileSignIns;
  },
  Effect.scoped,
  Effect.catchTag("PlatformError", () =>
    Effect.fail(new ProfileUnreadable({ detail: "The profile could not be copied or read." })),
  ),
);
