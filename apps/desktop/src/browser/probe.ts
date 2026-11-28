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
import * as Clock from "effect/Clock";
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
   * its databases open: an origin whose databases need a version change then
   * waits, written not at all. So does every origin not written by the
   * call's deadline, one whose change is held back included.
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
 * How long one read or write of site storage may take, all its origins
 * together, well within the server's own limit on a call. A database a page
 * holds back takes no longer: an origin not written by then waits, and one
 * whose databases were not read by then comes back without them, while the
 * rest of the sign-ins move on.
 */
const STORAGE_CALL_MS = 8_000;

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
 * probe kept in `shelf`, the window of the tabs no other window shows,
 * hidden there for good.
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
    // (both verified on Electron 44). Neither depends on the origin the probe shows, so cookies
    // never wait behind site storage.
    const readCookies = send("Network.getAllCookies").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CdpCookies)),
      Effect.catchTag("SchemaError", (error) => Effect.fail(failed(error.message))),
      Effect.map(({ cookies }) => cookies.flatMap((cookie) => Option.toArray(cookieOfCdp(cookie)))),
    );

    const writeCookies = (changes: BrowserCookieChanges) => {
      const cookies = [...changes.set.map(cdpParamOf), ...changes.removed.map(cdpRemovalOf)];
      return cookies.length === 0
        ? Effect.void
        : send("Network.setCookies", { cookies }).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => session.cookies.flushStore(),
                catch: (cause) => failed(`The cookies were not saved: ${String(cause)}`),
              }),
            ),
          );
    };

    /**
     * Runs `script` with `input` in the probe's page, at the origin it shows: its answer, by
     * value. The input goes in as JSON text the page parses, so a key such as `__proto__` stays
     * the record's own, as it would not in an object literal.
     */
    const inPage = <I>(script: (input: I) => Promise<unknown>, input: I) =>
      send("Runtime.evaluate", {
        expression: `(${script.toString()})(${
          input === undefined ? "undefined" : `JSON.parse(${JSON.stringify(JSON.stringify(input))})`
        })`,
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

    const deadlineFromNow = Effect.map(Clock.currentTimeMillis, (now) => now + STORAGE_CALL_MS);
    /** The time left until `until`, from now. */
    const leftUntil = (until: number) =>
      Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, until - now));

    const readStorage = (origins: ReadonlyArray<string>, indexedDb: boolean) =>
      // The deadline counts from the call, a wait for the probe included.
      deadlineFromNow.pipe(
        Effect.flatMap((until) =>
          one(
            Effect.gen(function* () {
              const read: Array<BrowserOriginStorage> = [];
              for (const given of origins) {
                const origin = webOrigin(given);
                if (origin === null) continue;
                yield* visit(origin);
                const localStorage = yield* readLocalStorage(origin);
                if (!indexedDb) {
                  read.push({ origin, localStorage });
                  continue;
                }
                // Databases a page holds back past the deadline, or holding a value the shared
                // shape cannot carry, are not read, rather than read wrong.
                const left = yield* leftUntil(until);
                const databases =
                  left === 0
                    ? Option.none()
                    : yield* readDatabasesHere.pipe(Effect.timeoutOption(left));
                read.push(
                  Option.isSome(databases) && databases.value.readable
                    ? { origin, localStorage, indexedDb: databases.value.databases }
                    : { origin, localStorage },
                );
              }
              return read;
            }).pipe(Effect.ensuring(leave)),
          ),
        ),
      );

    /**
     * Writes one origin, databases first: one that needs a version change
     * waits while a tab shows the origin; then nothing of it is written.
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
          // Asked again just before the change: a tab may have come to the origin meanwhile.
          if (shown(origin)) return "waiting";
          yield* replaceDatabasesHere({ databases, versionChanges: true });
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

    /**
     * Writes each origin in turn until the call's deadline; the rest wait.
     * One cut off by the deadline, held back by a page of it, may be partly
     * written: the probe leaves it, so its script ends, though a deletion
     * already asked for still happens once that page lets go. Answered
     * `waiting`, it is written again whole.
     */
    const writeStorage = (
      origins: ReadonlyArray<BrowserOriginStorage>,
      shown: (origin: string) => boolean,
    ) =>
      // The deadline counts from the call, a wait for the probe included.
      deadlineFromNow.pipe(
        Effect.flatMap((until) =>
          one(
            Effect.gen(function* () {
              const waiting: Array<string> = [];
              for (const stored of origins) {
                const left = yield* leftUntil(until);
                const outcome =
                  left === 0
                    ? Option.none()
                    : yield* writeOrigin(stored, shown).pipe(Effect.timeoutOption(left));
                if (Option.isSome(outcome) && outcome.value === "written") continue;
                if (Option.isNone(outcome)) yield* leave;
                waiting.push(stored.origin);
              }
              return waiting.length === 0 ? {} : { waiting };
            }).pipe(Effect.ensuring(leave)),
          ),
        ),
      );

    return { readCookies, writeCookies, readStorage, writeStorage };
  });
