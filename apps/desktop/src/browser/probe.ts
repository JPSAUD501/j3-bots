// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserCookie,
  type BrowserCookieChanges,
  BrowserHostError,
  type BrowserOriginStorage,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { type BaseWindow, type Session, WebContentsView } from "electron";
import {
  AllCookies,
  cookieFromCdp,
  toCdpCookie,
  toCdpRemovals,
  toElectronCookie,
} from "./cookies.ts";

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
  readonly readStorage: (
    origins: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<BrowserOriginStorage>, BrowserHostError>;
  readonly writeStorage: (
    origins: ReadonlyArray<BrowserOriginStorage>,
  ) => Effect.Effect<void, BrowserHostError>;
}

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

    const readCookies = one(
      send("Network.getAllCookies").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AllCookies)),
        Effect.catchTag("SchemaError", (error) => Effect.fail(failed(error.message))),
        Effect.map(({ cookies }) => cookies.map(cookieFromCdp)),
      ),
    );

    const writeCookies = (changes: BrowserCookieChanges) =>
      one(
        Effect.gen(function* () {
          for (const key of changes.removed) {
            for (const removal of toCdpRemovals(key)) yield* send("Network.deleteCookies", removal);
          }
          // Electron's API for the cookies it can hold; the debugger for a partitioned one.
          for (const cookie of changes.set) {
            if (cookie.partition === undefined) {
              yield* Effect.tryPromise({
                try: () => session.cookies.set(toElectronCookie(cookie)),
                catch: (cause) => failed(`A cookie was not set: ${String(cause)}`),
              });
            } else {
              yield* send("Network.setCookies", { cookies: [toCdpCookie(cookie)] });
            }
          }
          yield* Effect.promise(() => session.cookies.flushStore());
        }),
      );

    const readStorage = (origins: ReadonlyArray<string>) =>
      one(
        Effect.forEach(origins, (given) =>
          Effect.gen(function* () {
            const origin = webOrigin(given);
            if (origin === null) return [];
            yield* visit(origin);
            yield* send("DOMStorage.enable");
            const { entries } = yield* send("DOMStorage.getDOMStorageItems", {
              storageId: storageId(origin),
            }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(DOMStorageItems)),
              Effect.catchTag("SchemaError", (error) => Effect.fail(failed(error.message))),
            );
            return [{ origin, localStorage: entries.map(([name, value]) => ({ name, value })) }];
          }),
        ).pipe(
          Effect.map((read) => read.flat()),
          Effect.ensuring(leave),
        ),
      );

    const writeStorage = (origins: ReadonlyArray<BrowserOriginStorage>) =>
      one(
        Effect.forEach(
          origins,
          (stored) =>
            Effect.gen(function* () {
              const origin = webOrigin(stored.origin);
              if (origin === null) {
                return yield* new BrowserHostError({
                  reason: "refused",
                  detail: `${stored.origin} is not a web origin.`,
                });
              }
              yield* visit(origin);
              yield* send("DOMStorage.enable");
              yield* send("DOMStorage.clear", { storageId: storageId(origin) });
              for (const { name, value } of stored.localStorage) {
                yield* send("DOMStorage.setDOMStorageItem", {
                  storageId: storageId(origin),
                  key: name,
                  value,
                });
              }
            }),
          { discard: true },
        ).pipe(Effect.ensuring(leave)),
      );

    return { readCookies, writeCookies, readStorage, writeStorage };
  });
