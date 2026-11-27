// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type BrowserCookie,
  BrowserIndexedDb,
  type BrowserOriginStorage,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlSchema from "effect/sql/SqlSchema";
import { chromium } from "playwright-core";
import { cookieOfCdp } from "./cookies.ts";

// The sign-ins a Chromium profile on the disk holds: its cookies, and the
// storage and databases of the sites it was used on. For the one move of the
// engine's browser's sign-ins into J3 Bots' own, once (decision 0110). The
// profile is read from a private copy, by the Chromium that wrote it or a
// newer one, with every request answered by an empty page here: no request
// leaves the machine, and the profile itself is never changed.

/** One origin's storage read from a profile, and whether it held databases. */
export interface ProfileOrigin {
  readonly storage: BrowserOriginStorage;
  readonly indexedDb: boolean;
}

export interface ProfileSignIns {
  readonly cookies: ReadonlyArray<BrowserCookie>;
  readonly origins: ReadonlyArray<ProfileOrigin>;
}

/** The profile could not be read; nothing of it was taken. */
export class ProfileUnreadable extends Schema.TaggedError<ProfileUnreadable>()(
  "ProfileUnreadable",
  { detail: Schema.String },
) {}

/** The most origins of the profile's history whose storage is read: the latest visited. */
const MOST_ORIGINS = 300;
/** How long a page at one origin may take to open, routed to an empty page. */
const ORIGIN_MS = 5_000;
/** The files a running Chromium leaves in its profile, which stop another from opening it. */
const LOCKS = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

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
    if (origins.size >= MOST_ORIGINS) break;
  }
  return [...origins];
}, Effect.provide(Reactivity.layer));

/**
 * Reads the sign-ins of the Chromium profile at `profile` with the browser
 * at `executablePath`.
 */
export const readProfileSignIns = Effect.fn("profile.read")(
  function* (input: { readonly profile: string; readonly executablePath: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const copy = yield* fs.makeTempDirectoryScoped({ prefix: "j3-bots-profile-" });
    yield* fs.copy(input.profile, copy, { overwrite: true });
    yield* Effect.forEach(LOCKS, (lock) => fs.remove(path.join(copy, lock), { force: true }), {
      discard: true,
    });
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
          }),
        catch: () => new ProfileUnreadable({ detail: "The browser did not open the profile." }),
      }),
      (opened) => Effect.promise(() => opened.close()),
    );
    const attempt = <A>(detail: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: () => new ProfileUnreadable({ detail }) });
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

    const origins = new Set(visited);
    for (const cookie of cookies) origins.add(`https://${cookie.domain}`);
    for (const origin of origins)
      yield* Effect.promise(() =>
        page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: ORIGIN_MS }).then(
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
      origins: state.origins.flatMap((origin): ReadonlyArray<ProfileOrigin> => {
        const databases = origin.indexedDB ?? [];
        if (origin.localStorage.length === 0 && databases.length === 0) return [];
        return [
          {
            indexedDb: databases.length > 0,
            storage: {
              origin: origin.origin,
              localStorage: origin.localStorage,
              ...(databases.length > 0 ? { indexedDb: databases } : {}),
            },
          },
        ];
      }),
    } satisfies ProfileSignIns;
  },
  Effect.scoped,
  Effect.catchTag("PlatformError", () =>
    Effect.fail(new ProfileUnreadable({ detail: "The profile could not be copied." })),
  ),
);
