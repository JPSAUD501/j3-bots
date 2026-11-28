// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cdpParamOf,
  cdpRemovalOf,
  cookieOfCdp,
  readDatabases,
  replaceDatabases,
} from "@j3-bots/browser";
import {
  type BrowserCookie,
  type BrowserCookieChanges,
  BrowserHostError,
  BrowserIndexedDb,
  type BrowserOriginStorage,
  type BrowserStorageWritten,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { type BaseWindow, type Session, WebContentsView } from "electron";

// The shared sign-ins as the desktop's browser keeps them, read and written
// through a probe: a view of the browser's partition that is never shown and
// whose every request is answered with an empty page. It loads an origin no
// tab shows, so the origin's storage can be reached, without running any of
// the site's code (phase 0: `DOMStorage` by storage key alone fails with
// "Frame not found").

/** The sign-ins' cookies and site storage, on the partition the probe was made in. */
export interface SignIns {
  readonly readCookies: Effect.Effect<ReadonlyArray<BrowserCookie>, BrowserHostError>;
  readonly writeCookies: (changes: BrowserCookieChanges) => Effect.Effect<void, BrowserHostError>;
  /** Each origin's `localStorage`, and its databases when `indexedDb`. */
  readonly readStorage: (
    origins: ReadonlyArray<string>,
    indexedDb: boolean,
  ) => Effect.Effect<ReadonlyArray<BrowserOriginStorage>, BrowserHostError>;
  /**
   * Replaces each origin's `localStorage`, and its databases where given.
   * `shown` says whether a tab shows the origin, whose page may hold one of
   * its databases open: an origin whose databases need a version change
   * then waits, written not at all, as does one whose change is held back.
   */
  readonly writeStorage: (
    origins: ReadonlyArray<BrowserOriginStorage>,
    shown: (origin: string) => boolean,
  ) => Effect.Effect<BrowserStorageWritten, BrowserHostError>;
}

/** Cookies as `Network.getAllCookies` answers, each read by the shared mapping. */
const CdpCookies = Schema.Struct({ cookies: Schema.Array(Schema.Unknown) });

/** What `Runtime.evaluate` answers, by value. */
const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) }),
  exceptionDetails: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
});
/** An origin's databases as the probe read them, or that it could not. */
const DatabasesRead = Schema.Union([
  Schema.Struct({ readable: Schema.Literal(true), databases: Schema.Array(BrowserIndexedDb) }),
  Schema.Struct({ readable: Schema.Literal(false) }),
]);
const decodeEvaluated = Schema.decodeUnknownEffect(Evaluated);
const decodeDatabasesRead = Schema.decodeUnknownEffect(DatabasesRead);
const decodeDatabasesWritten = Schema.decodeUnknownEffect(
  Schema.Literals(["written", "version-change"]),
);

/**
 * How long a version change of an origin's databases may take: past it, a
 * page of the origin holds it back, and the origin waits, alone, while the
 * rest of the sign-ins move on.
 */
const VERSION_CHANGE_MS = 10_000;

const DOMStorageItems = Schema.Struct({
  entries: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
const FetchPaused = Schema.Struct({ requestId: Schema.String });
const decodeFetchPaused = Schema.decodeUnknownOption(FetchPaused);

const EMPTY_PAGE = Buffer.from("<!doctype html><title></title>").toString("base64");

const failed = (detail: string) =>
  new BrowserHostError({ reason: "page", detail: detail.slice(0, 500) });

/** `scheme://host[:port]` of `origin`, or null when it is not a web origin. */
const webOrigin = (origin: string): string | null => {
  const parsed = URL.parse(origin);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
  return parsed.origin;
};

/**
 * The sign-ins of `session`, for as long as the scope lives, through a
 * probe kept in `shelf`, a window that is never shown.
 */
export const makeSignIns = (
  session: Session,
  shelf: BaseWindow,
): Effect.Effect<SignIns, BrowserHostError, Scope.Scope> =>
  Effect.gen(function* () {
    const view = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const made = new WebContentsView({
          webPreferences: { session, sandbox: true, contextIsolation: true },
        });
        made.setVisible(false);
        shelf.contentView.addChildView(made);
        return made;
      }),
      (made) =>
        Effect.sync(() => {
          shelf.contentView.removeChildView(made);
          if (!made.webContents.isDestroyed()) made.webContents.close();
        }),
    );
    const contents = view.webContents;
    const send = (method: string, params?: object) =>
      Effect.tryPromise({
        try: (): Promise<unknown> => contents.debugger.sendCommand(method, params),
        catch: (cause) => failed(`${method}: ${String(cause)}`),
      });
    yield* Effect.try({
      try: () => contents.debugger.attach("1.3"),
      catch: (cause) => failed(`The probe's debugger did not attach: ${String(cause)}`),
    });
    contents.debugger.on("message", (_event, method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const paused = decodeFetchPaused(params);
      if (paused._tag === "None") return;
      void contents.debugger
        .sendCommand("Fetch.fulfillRequest", {
          requestId: paused.value.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html" }],
          body: EMPTY_PAGE,
        })
        .catch(() => undefined);
    });
    // A page first: a view that has loaded nothing has no renderer to enable domains in.
    yield* Effect.tryPromise({
      try: () => contents.loadURL("about:blank"),
      catch: (cause) => failed(`The probe did not open: ${String(cause)}`),
    });
    // A site's service worker would answer the probe's visit with the site itself: it is passed by.
    yield* send("Network.enable", {});
    yield* send("Network.setBypassServiceWorker", { bypass: true });
    yield* send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

    // One piece of work at a time: the probe shows one origin at once.
    const lock = yield* Semaphore.make(1);
    const one = <A>(effect: Effect.Effect<A, BrowserHostError>) => lock.withPermits(1)(effect);

    const visit = (origin: string) =>
      Effect.tryPromise({
        try: () => contents.loadURL(`${origin}/`),
        catch: (cause) => failed(`The probe did not reach ${origin}: ${String(cause)}`),
      });
    // Back to a blank page, so no origin stays loaded between pieces of work.
    const leave = Effect.ignore(
      Effect.tryPromise({
        try: () => contents.loadURL("about:blank"),
        catch: (cause) => failed(String(cause)),
      }),
    );
    const storageId = (origin: string) => ({ storageKey: `${origin}/`, isLocalStorage: true });

    // Through the probe's own page, `Network` reaches its partition's cookies, a partitioned
    // one's whole partition included; `Storage` would reach the app's default session instead
    // (both verified on Electron 44).
    const readCookies = one(
      send("Network.getAllCookies").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CdpCookies)),
        Effect.catchTag("SchemaError", (error) => Effect.fail(failed(error.message))),
        Effect.map(({ cookies }) =>
          cookies.flatMap((cookie) => Option.toArray(cookieOfCdp(cookie))),
        ),
      ),
    );

    const writeCookies = (changes: BrowserCookieChanges) => {
      const cookies = [...changes.set.map(cdpParamOf), ...changes.removed.map(cdpRemovalOf)];
      return cookies.length === 0
        ? Effect.void
        : one(
            send("Network.setCookies", { cookies }).pipe(
              Effect.andThen(Effect.promise(() => session.cookies.flushStore())),
            ),
          );
    };

    /** Runs `script` with `input` in the probe's page, at the origin it shows: its answer, by value. */
    const inPage = <I>(script: (input: I) => Promise<unknown>, input: I) =>
      send("Runtime.evaluate", {
        expression: `(${script.toString()})(${JSON.stringify(input) ?? "undefined"})`,
        awaitPromise: true,
        returnByValue: true,
      }).pipe(
        Effect.flatMap((answer) =>
          decodeEvaluated(answer).pipe(Effect.mapError((error) => failed(error.message))),
        ),
        Effect.flatMap((evaluated) =>
          evaluated.exceptionDetails === undefined
            ? Effect.succeed(evaluated.result.value)
            : Effect.fail(failed(evaluated.exceptionDetails.text)),
        ),
      );
    const readDatabasesHere = inPage(readDatabases, undefined).pipe(
      Effect.flatMap((value) =>
        decodeDatabasesRead(value).pipe(Effect.mapError((error) => failed(error.message))),
      ),
    );
    const replaceDatabasesHere = (input: Parameters<typeof replaceDatabases>[0]) =>
      inPage(replaceDatabases, input).pipe(
        Effect.flatMap((value) =>
          decodeDatabasesWritten(value).pipe(Effect.mapError((error) => failed(error.message))),
        ),
      );

    const readLocalStorage = Effect.fn("SignIns.readLocalStorage")(function* (origin: string) {
      yield* send("DOMStorage.enable");
      const { entries } = yield* send("DOMStorage.getDOMStorageItems", {
        storageId: storageId(origin),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DOMStorageItems)),
        Effect.catchTag("SchemaError", (error) => Effect.fail(failed(error.message))),
      );
      return entries.map(([name, value]) => ({ name, value }));
    });

    const readStorage = (origins: ReadonlyArray<string>, indexedDb: boolean) =>
      one(
        Effect.forEach(origins, (given) =>
          Effect.gen(function* () {
            const origin = webOrigin(given);
            if (origin === null) return [];
            yield* visit(origin);
            const localStorage = yield* readLocalStorage(origin);
            if (!indexedDb) return [{ origin, localStorage }];
            // Databases holding a value the shared shape cannot carry are not read, rather than read wrong.
            const read = yield* readDatabasesHere;
            return [
              read.readable
                ? { origin, localStorage, indexedDb: read.databases }
                : { origin, localStorage },
            ];
          }),
        ).pipe(
          Effect.map((read) => read.flat()),
          Effect.ensuring(leave),
        ),
      );

    /**
     * Writes one origin, databases first: one that needs a version change
     * waits while a tab shows the origin, and whenever the change takes too
     * long; then nothing of the origin is written.
     */
    const writeOrigin = Effect.fn("SignIns.writeOrigin")(function* (
      stored: BrowserOriginStorage,
      shown: (origin: string) => boolean,
    ) {
      const origin = webOrigin(stored.origin);
      if (origin === null) {
        return yield* new BrowserHostError({
          reason: "refused",
          detail: `${stored.origin} is not a web origin.`,
        });
      }
      yield* visit(origin);
      const databases = stored.indexedDb;
      if (databases !== undefined) {
        const written = yield* replaceDatabasesHere({ databases, versionChanges: false });
        if (written === "version-change") {
          if (shown(origin)) return "waiting";
          // A worker of the origin may hold a database open too.
          yield* send("ServiceWorker.enable");
          yield* send("ServiceWorker.stopAllWorkers");
          const changed = yield* replaceDatabasesHere({ databases, versionChanges: true }).pipe(
            Effect.timeoutOption(VERSION_CHANGE_MS),
          );
          // Held back: the probe leaves the origin. A deletion already asked for still happens
          // once the page holding the database lets go, and the server writes the origin again.
          if (Option.isNone(changed)) {
            yield* leave;
            return "waiting";
          }
        }
      }
      yield* send("DOMStorage.enable");
      yield* send("DOMStorage.clear", { storageId: storageId(origin) });
      for (const { name, value } of stored.localStorage) {
        yield* send("DOMStorage.setDOMStorageItem", {
          storageId: storageId(origin),
          key: name,
          value,
        });
      }
      return "written";
    });

    const writeStorage = (
      origins: ReadonlyArray<BrowserOriginStorage>,
      shown: (origin: string) => boolean,
    ) =>
      one(
        Effect.forEach(origins, (stored) =>
          writeOrigin(stored, shown).pipe(
            Effect.map((outcome) => (outcome === "waiting" ? [stored.origin] : [])),
          ),
        ).pipe(
          Effect.map((outcomes): BrowserStorageWritten => {
            const waiting = outcomes.flat();
            return waiting.length === 0 ? {} : { waiting };
          }),
          Effect.ensuring(leave),
        ),
      );

    return { readCookies, writeCookies, readStorage, writeStorage };
  });
