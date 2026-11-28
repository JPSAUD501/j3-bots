// SPDX-License-Identifier: AGPL-3.0-or-later
// The launch flags and the Chrome identity follow T3 Code v0.1.13,
// apps/server/src/preview/ServerBrowserContexts.ts (MIT License, Copyright (c)
// 2026 T3 Tools Inc.; see packages/browser/NOTICE), with the changes the 0.16
// browser spike measured: full Chrome for Testing, a device scale factor of 1,
// and client hints that name the form factor.
import {
  BROWSER_HOST_PROTOCOL_VERSION,
  type BrowserCookieChanges,
  BrowserDownloadId,
  BrowserHostError,
  type BrowserHostEvent,
  type BrowserHostHello,
  BrowserIndexedDb,
  type BrowserOriginStorage,
  type BrowserStorageWritten,
  BrowserTabRef,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
} from "@j3-bots/contracts";
import {
  cdpParamOf,
  cdpRemovalOf,
  cookieOfCdp,
  type DriverPage,
  driverTabCalls,
  hostErrorOf,
  makeDriverPage,
  type PageHost,
  type PageHostPayload,
  readDatabases,
  replaceDatabases,
} from "@j3-bots/browser";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Download,
  type Page,
} from "playwright-core";
import { CHROME_VERSION, type ChromePlatform } from "./chrome.ts";

/** Cookies as `Storage.getCookies` answers, each read by the shared mapping. */
const CdpCookies = Schema.Struct({ cookies: Schema.Array(Schema.Unknown) });

/** An origin's databases as a page of it read them, or that it could not. */
const decodeDatabasesRead = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ readable: Schema.Literal(true), databases: Schema.Array(BrowserIndexedDb) }),
    Schema.Struct({ readable: Schema.Literal(false) }),
  ]),
);

/** What signing out clears of an origin besides cookies, as `Storage.clearDataForOrigin` names it. */
const CLEARED_STORAGE = [
  "local_storage",
  "indexeddb",
  "cache_storage",
  "service_workers",
  "file_systems",
  "websql",
  "shared_storage",
  "storage_buckets",
].join(",");

/** An address's origin, for http and https alone. */
const webOriginOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The page size every server tab has, in CSS pixels: a laptop's. */
const VIEWPORT = { width: 1280, height: 800 } as const;

const MAJOR = CHROME_VERSION.split(".")[0] ?? "0";

/**
 * Chrome's reduced user agent per system: the version past the major is
 * zeros, and Linux always says x86_64, as Chrome itself does.
 */
const PLATFORM_UA: Readonly<Record<ChromePlatform, string>> = {
  linux64: "X11; Linux x86_64",
  "linux-arm64": "X11; Linux x86_64",
  "mac-arm64": "Macintosh; Intel Mac OS X 10_15_7",
  "mac-x64": "Macintosh; Intel Mac OS X 10_15_7",
  win64: "Windows NT 10.0; Win64; x64",
};

const HINT_PLATFORM: Readonly<Record<ChromePlatform, string>> = {
  linux64: "Linux",
  "linux-arm64": "Linux",
  "mac-arm64": "macOS",
  "mac-x64": "macOS",
  win64: "Windows",
};

const userAgentOf = (platform: ChromePlatform) =>
  `Mozilla/5.0 (${PLATFORM_UA[platform]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36`;

const brands = (version: (major: string) => string) => [
  { brand: "Chromium", version: version(MAJOR) },
  { brand: "Google Chrome", version: version(MAJOR) },
  { brand: "Not A(Brand", version: version("99") },
];

/** The browser as sites see it: Chrome of its own version, on this system, a desktop. */
const presentAsChrome = (cdp: CDPSession, platform: ChromePlatform) =>
  cdp.send("Emulation.setUserAgentOverride", {
    userAgent: userAgentOf(platform),
    userAgentMetadata: {
      brands: brands((major) => major),
      fullVersionList: brands((major) => (major === MAJOR ? CHROME_VERSION : `${major}.0.0.0`)),
      platform: HINT_PLATFORM[platform],
      platformVersion: "",
      architecture: platform === "linux-arm64" || platform === "mac-arm64" ? "arm" : "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
      formFactors: ["Desktop"],
    },
  });

/** The browser could not start: why, as far as the server can tell. */
export class ServerBrowserFailed extends Schema.TaggedError<ServerBrowserFailed>()(
  "ServerBrowserFailed",
  { reason: Schema.Literals(["sandbox", "libraries", "other"]), detail: Schema.String },
) {}

/** What a failed launch's message says of its cause. */
const failureOf = (cause: unknown): ServerBrowserFailed => {
  const detail = String(cause).slice(0, 1_000);
  if (/No usable sandbox|setuid sandbox|namespace/i.test(detail))
    return new ServerBrowserFailed({ reason: "sandbox", detail });
  if (/error while loading shared libraries|cannot open shared object/i.test(detail))
    return new ServerBrowserFailed({ reason: "libraries", detail });
  return new ServerBrowserFailed({ reason: "other", detail });
};

/** The server's browser while it runs: a page host, and how many tabs it has. */
export interface ServerHost extends PageHost {
  readonly tabCount: Effect.Effect<number>;
}

interface Tab {
  readonly driver: DriverPage;
  readonly scope: Scope.Closeable;
  /**
   * The folder of the files put for the tab's uploads, under a name of the
   * server's own: a ref is not the server's to trust as a path.
   */
  readonly files: string;
}

/** 128 bits of randomness, in hex. */
const randomHex = Effect.gen(function* () {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = yield* Random.nextIntBetween(0, 256);
  return Encoding.encode(bytes);
});

/** A ref for a tab the browser opened by itself. */
const mintRef = Effect.map(randomHex, (hex) => BrowserTabRef.make(`tab_${hex}`));

/** A name a site gave a download, as a file name with no folder in it. */
const fileNameOf = (suggested: string): string => {
  const name = suggested
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  return name.length === 0 || name === "." || name === ".." ? "download" : name;
};

/**
 * Launches the browser at `executable` over a pipe, which only this process
 * holds, with one context and no profile on disk, for as long as the scope
 * lives. Sign-ins are written into it through `writeCookies` and
 * `writeStorage`; nothing seeds it at launch. The files a bot uploads and
 * the browser downloads live in a private temporary folder, removed with it.
 */
export const launchServerHost = (input: {
  readonly executable: string;
  readonly platform: ChromePlatform;
}): Effect.Effect<
  ServerHost,
  ServerBrowserFailed,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { platform } = input;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filesRoot = yield* fs
      .makeTempDirectoryScoped({ prefix: "j3-bots-browser-" })
      .pipe(Effect.mapError((cause) => failureOf(cause)));
    const browser: Browser = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          chromium.launch({
            executablePath: input.executable,
            headless: true,
            // Chrome's own sandbox: a host that blocks it is set up once, as
            // `j3-bots doctor` says.
            chromiumSandbox: true,
            args: [
              "--force-device-scale-factor=1",
              "--disable-blink-features=AutomationControlled",
              `--user-agent=${userAgentOf(platform)}`,
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-background-networking",
            ],
            ignoreDefaultArgs: ["--enable-automation"],
          }),
        catch: failureOf,
      }),
      (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
    );
    const context: BrowserContext = yield* Effect.tryPromise({
      try: () =>
        browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          userAgent: userAgentOf(platform),
          // A download stays in Playwright's own folder until the server
          // takes it (`download.take`) or the browser closes.
          acceptDownloads: true,
          serviceWorkers: "allow",
        }),
      catch: failureOf,
    });
    const browserCdp = yield* Effect.tryPromise({
      try: () => browser.newBrowserCDPSession(),
      catch: failureOf,
    });
    const contextId = yield* Effect.tryPromise({
      try: async () => {
        const probe = await context.newPage();
        const cdp = await context.newCDPSession(probe);
        const info = await cdp.send("Target.getTargetInfo");
        await cdp.detach();
        await probe.close();
        return info.targetInfo.browserContextId;
      },
      catch: failureOf,
    });
    if (contextId === undefined)
      return yield* new ServerBrowserFailed({ reason: "other", detail: "No browser context id." });

    const hostScope = yield* Effect.scope;
    const events = yield* PubSub.unbounded<BrowserHostEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    // A browser that exits, or crashes, ends the host's events, so the
    // server knows it is gone.
    const disconnected = Deferred.makeUnsafe<void>();
    browser.once("disconnected", () => Deferred.doneUnsafe(disconnected, Exit.void));
    if (!browser.isConnected()) Deferred.doneUnsafe(disconnected, Exit.void);
    const tabs = new Map<BrowserTabRef, Tab>();
    const drivers = new Map<BrowserTabRef, DriverPage>();
    /** The tabs being opened, for an open of the same ref meanwhile. */
    const opening = new Map<BrowserTabRef, Deferred.Deferred<DriverPage, BrowserHostError>>();
    /** Downloads reported and not taken yet. */
    const downloads = new Map<BrowserDownloadId, Download>();
    /** Every origin a frame of a tab showed, which signing out of all sites clears. */
    const shownOrigins = new Set<string>();
    /** Runs a page's callback's work in the host's scope. */
    const run = yield* FiberSet.makeRuntime<never>();

    const publish = (event: BrowserHostEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    /** Drives `page` as `ref` until the page closes or the host does. */
    const adopt = Effect.fnUntraced(function* (ref: BrowserTabRef, page: Page) {
      const scope = yield* Scope.fork(hostScope);
      const cdp = yield* Effect.tryPromise({
        try: async () => {
          const session = await context.newCDPSession(page);
          await presentAsChrome(session, platform);
          return session;
        },
        catch: hostErrorOf,
      }).pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
      const driver = yield* makeDriverPage({ tab: ref, page, cdp }).pipe(Scope.provide(scope));
      const files = path.join(filesRoot, yield* randomHex);
      tabs.set(ref, { driver, scope, files });
      drivers.set(ref, driver);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          tabs.delete(ref);
          drivers.delete(ref);
        }).pipe(
          // The files put for the tab's uploads go with it.
          Effect.andThen(fs.remove(files, { recursive: true, force: true })),
          Effect.ignore,
        ),
      ).pipe(Scope.provide(scope));
      yield* driver.changes.pipe(
        Stream.runForEach((state) => publish({ type: "tab.changed", page: state })),
        Effect.forkIn(scope),
      );
      page.on("framenavigated", (frame) => {
        const origin = webOriginOf(frame.url());
        if (origin !== undefined) shownOrigins.add(origin);
      });
      // A page this one opens, as a sign-in's pop-up, is a tab of its own,
      // kept on this browser, since it needs its opener.
      page.on("popup", (popup) => {
        run(
          Effect.gen(function* () {
            const popupRef = yield* mintRef;
            const opened = yield* adopt(popupRef, popup);
            yield* publish({
              type: "tab.opened",
              page: yield* opened.state,
              opener: ref,
              private: false,
            });
          }).pipe(Effect.ignore),
        );
      });
      // What a page downloads is reported as it starts, when the server
      // decides whose it is, and again once it finished. The server takes
      // it, or lets it go, by its id.
      page.on("download", (download) => {
        run(
          Effect.gen(function* () {
            const id = BrowserDownloadId.make(`dl_${yield* randomHex}`);
            yield* publish({ type: "download.started", tab: ref, download: id });
            const failure = yield* Effect.promise(() => download.failure());
            if (failure !== null) {
              return yield* publish({
                type: "download.finished",
                tab: ref,
                download: id,
                name: fileNameOf(download.suggestedFilename()),
                size: 0,
                // Playwright names a download stopped before its end `canceled`.
                outcome: failure === "canceled" ? "cancelled" : "failed",
              });
            }
            const file = yield* Effect.promise(() => download.path());
            const info = yield* fs.stat(file);
            downloads.set(id, download);
            yield* publish({
              type: "download.finished",
              tab: ref,
              download: id,
              name: fileNameOf(download.suggestedFilename()),
              size: Number(info.size),
            });
          }).pipe(Effect.ignore),
        );
      });
      /** The tab is gone: its scope closes and the server hears it once. */
      const ended = Effect.fnUntraced(function* (crashed: boolean) {
        if (tabs.get(ref)?.driver !== driver) return;
        yield* Scope.close(scope, Exit.void);
        yield* publish({ type: "tab.closed", tab: ref, crashed });
      });
      // A crashed page stays open and answers nothing more, so it is closed here.
      page.once("crash", () => {
        run(
          ended(true).pipe(
            Effect.andThen(Effect.promise(() => page.close().catch(() => undefined))),
          ),
        );
      });
      page.once("close", () => {
        run(ended(false));
      });
      return driver;
    });

    const tabCalls = driverTabCalls(drivers, (pointer) => publish(pointer));

    const send = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({ try: work, catch: hostErrorOf });

    const filesFailed = () =>
      new BrowserHostError({ reason: "page", detail: "The file could not be kept." });

    const putFile: PageHost["putFile"] = Effect.fn("ServerHost.putFile")(function* (request) {
      const tab = tabs.get(request.tab);
      if (tab === undefined) return yield* new BrowserHostError({ reason: "no-tab" });
      const folder = path.join(tab.files, yield* randomHex);
      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(filesFailed));
      const file = path.join(folder, request.name);
      yield* fs.writeFile(file, request.bytes).pipe(Effect.mapError(filesFailed));
      return { path: file };
    });

    const takeDownload: PageHost["takeDownload"] = Effect.fn("ServerHost.takeDownload")(
      function* (request) {
        const download = downloads.get(request.download);
        if (download === undefined)
          return yield* new BrowserHostError({ reason: "invalid-target" });
        downloads.delete(request.download);
        const release = Effect.promise(() => download.delete()).pipe(Effect.ignore);
        const file = yield* send(() => download.path()).pipe(Effect.tapError(() => release));
        const info = yield* fs.stat(file).pipe(
          Effect.mapError(filesFailed),
          Effect.tapError(() => release),
        );
        if (Number(info.size) > MAX_ATTACHMENT_SIZE) {
          yield* release;
          return yield* new BrowserHostError({ reason: "too-large" });
        }
        const bytes = yield* fs
          .readFile(file)
          .pipe(Effect.mapError(filesFailed), Effect.ensuring(release));
        return { bytes };
      },
    );

    const readCookies = send(() =>
      browserCdp.send("Storage.getCookies", { browserContextId: contextId }),
    ).pipe(
      Effect.flatMap((answer) =>
        Schema.decodeEffect(CdpCookies)(answer).pipe(
          Effect.mapError(
            () => new BrowserHostError({ reason: "page", detail: "Unreadable cookies." }),
          ),
        ),
      ),
      Effect.map(({ cookies }) => ({
        cookies: cookies.flatMap((cookie) => Option.toArray(cookieOfCdp(cookie))),
      })),
    );

    const writeCookies = (changes: BrowserCookieChanges) => {
      const params = [...changes.set.map(cdpParamOf), ...changes.removed.map(cdpRemovalOf)];
      return params.length === 0
        ? Effect.void
        : send(() =>
            browserCdp.send("Storage.setCookies", {
              browserContextId: contextId,
              cookies: params.map((param) => ({ ...param })),
            }),
          ).pipe(Effect.asVoid);
    };

    /**
     * Runs `use` in a page of `origin` that no site's code runs in: every
     * request it makes is answered with an empty page, past any service
     * worker of the origin, which would otherwise answer it before the route
     * (**Assumed**: `Network.setBypassServiceWorker` covers the navigation).
     * What it reads and writes is the origin's own storage. A call that is
     * interrupted, as one past its time is, closes the page, and what runs in
     * it stops.
     */
    const inProbe = <A>(origin: string, use: (page: Page, cdp: CDPSession) => Promise<A>) =>
      Effect.tryPromise({
        try: async (signal) => {
          const page = await context.newPage();
          const close = () => {
            void page.close().catch(() => undefined);
          };
          signal.addEventListener("abort", close, { once: true });
          try {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Network.enable");
            await cdp.send("Network.setBypassServiceWorker", { bypass: true });
            await page.route("**/*", (route) =>
              route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }),
            );
            await page.goto(new URL("/", origin).toString(), { waitUntil: "domcontentloaded" });
            return await use(page, cdp);
          } finally {
            signal.removeEventListener("abort", close);
            await page.close();
          }
        },
        catch: hostErrorOf,
      });

    /** Whether a frame of a tab shows `origin`, so a page of it may hold its databases open. */
    const showsOrigin = (origin: string) =>
      [...tabs.values()].some(({ driver }) =>
        driver.page.frames().some((frame) => webOriginOf(frame.url()) === origin),
      );

    /**
     * Each origin's `localStorage`, and its databases when `indexedDb`: every
     * record of them, in the shape Playwright's `storageState` gives, read in
     * the probe. An origin whose databases hold a value that shape cannot
     * carry comes back without them.
     */
    const readStorage = (input: PageHostPayload<"storage.read">) =>
      Effect.forEach(input.origins, (origin) =>
        inProbe(origin, async (page) => ({
          localStorage: await page.evaluate(() =>
            Object.keys(localStorage).map((name) => ({
              name,
              value: localStorage.getItem(name) ?? "",
            })),
          ),
          databases: input.indexedDb ? await page.evaluate(readDatabases) : undefined,
        })).pipe(
          Effect.flatMap(({ localStorage, databases }) =>
            databases === undefined
              ? Effect.succeed<BrowserOriginStorage>({ origin, localStorage })
              : decodeDatabasesRead(databases).pipe(
                  Effect.mapError(
                    () => new BrowserHostError({ reason: "page", detail: "Unreadable databases." }),
                  ),
                  Effect.map((read): BrowserOriginStorage =>
                    read.readable
                      ? { origin, localStorage, indexedDb: read.databases }
                      : { origin, localStorage },
                  ),
                ),
          ),
        ),
      ).pipe(Effect.map((origins) => ({ origins })));

    /**
     * Replaces each origin's `localStorage`, and its databases where given,
     * from the probe. Databases that differ only in their records are filled
     * again in place, past a tab of the origin that holds them open. One that
     * must be deleted, or opened at another version, waits until no tab
     * shows the origin, so no page of it can hold the change back: until
     * then nothing of the origin is written, it is answered `waiting`, and
     * the sign-ins write it again later. Before that change the origin's
     * service workers are stopped, as they may hold one open too
     * (**Assumed**: nothing else of a context does).
     */
    const writeStorage = (origins: ReadonlyArray<BrowserOriginStorage>) =>
      Effect.forEach(origins, (stored) =>
        inProbe(stored.origin, async (page, cdp) => {
          const databases = stored.indexedDb;
          if (databases !== undefined) {
            const written = await page.evaluate(replaceDatabases, {
              databases,
              versionChanges: false,
            });
            if (written === "version-change") {
              if (showsOrigin(stored.origin)) return "waiting";
              await cdp.send("ServiceWorker.enable");
              await cdp.send("ServiceWorker.stopAllWorkers");
              await page.evaluate(replaceDatabases, { databases, versionChanges: true });
            }
          }
          await page.evaluate((items) => {
            localStorage.clear();
            for (const item of items) localStorage.setItem(item.name, item.value);
          }, stored.localStorage);
          return "written";
        }).pipe(Effect.map((outcome) => (outcome === "waiting" ? [stored.origin] : []))),
      ).pipe(
        Effect.map((outcomes): BrowserStorageWritten => {
          const waiting = outcomes.flat();
          return waiting.length === 0 ? {} : { waiting };
        }),
      );

    /**
     * Deletes the site data of `clear`'s origins, or of every origin a tab
     * showed, besides cookies, from a page of the context: CDP's `Storage`
     * clears the storage of the target's own browser context, as
     * `ServerHost.test.ts` checks. Then each open tab of those origins loses
     * its `sessionStorage`, which
     * CDP does not clear, in every frame of them, and a tab whose page is of
     * one loads again, so no page keeps a sign-in in its memory either.
     */
    const clearStorage = (clear: PageHostPayload<"storage.clear">["clear"]) => {
      const origins = "all" in clear ? [...shownOrigins] : clear.origins;
      const ofThem = (url: string) => {
        const origin = webOriginOf(url);
        return origin !== undefined && ("all" in clear || clear.origins.includes(origin));
      };
      const cleared =
        origins.length === 0
          ? Effect.void
          : send(async () => {
              const page = await context.newPage();
              try {
                const cdp = await context.newCDPSession(page);
                for (const origin of origins)
                  await cdp.send("Storage.clearDataForOrigin", {
                    origin,
                    storageTypes: CLEARED_STORAGE,
                  });
              } finally {
                await page.close();
              }
            });
      const signedOutTabs = Effect.forEach(
        [...tabs.values()],
        ({ driver }) =>
          send(async () => {
            const { page } = driver;
            for (const frame of page.frames())
              if (ofThem(frame.url()))
                await frame.evaluate(() => sessionStorage.clear()).catch(() => undefined);
            if (ofThem(page.url())) await page.reload({ waitUntil: "commit" });
          }),
        { discard: true },
      );
      return Effect.andThen(cleared, signedOutTabs);
    };

    /**
     * The tab's page: the one open, the one opening, or a new one, so a ref
     * has one page however many ask at once. The opening is listed and its
     * removal set in one step, so no interrupt leaves it listed. Making the
     * page and adopting it cannot be interrupted either, since Playwright
     * makes the page anyway: a page whose adoption fails is closed. A
     * browser that stops answering ends these, as it ends every call.
     */
    const pageFor = (tab: BrowserTabRef): Effect.Effect<DriverPage, BrowserHostError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const existing = tabs.get(tab);
          if (existing !== undefined) return Effect.succeed(existing.driver);
          const inFlight = opening.get(tab);
          if (inFlight !== undefined) return restore(Deferred.await(inFlight));
          const made = Deferred.makeUnsafe<DriverPage, BrowserHostError>();
          opening.set(tab, made);
          return send(() => context.newPage()).pipe(
            Effect.flatMap((page) =>
              adopt(tab, page).pipe(
                Effect.tapError(() => send(() => page.close()).pipe(Effect.ignore)),
              ),
            ),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                opening.delete(tab);
                Deferred.doneUnsafe(made, exit);
              }),
            ),
          );
        }),
      );

    const open: PageHost["open"] = Effect.fn("ServerHost.open")(function* (request) {
      if (request.private)
        return yield* new BrowserHostError({
          reason: "unsupported",
          detail: "A private tab opens only in the app.",
        });
      const driver = yield* pageFor(request.tab);
      if (request.url === undefined) return yield* driver.state;
      return yield* driver.navigate(
        { kind: "url", url: request.url },
        { readiness: request.readiness, timeoutMs: request.timeoutMs },
      );
    });

    const close = (tab: BrowserTabRef) =>
      Effect.suspend(() => {
        const found = tabs.get(tab);
        if (found === undefined) return Effect.void;
        return send(() => found.driver.page.close()).pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(found.scope, Exit.void)),
        );
      });

    const hello: Effect.Effect<BrowserHostHello, BrowserHostError> = Effect.gen(function* () {
      const states = yield* Effect.forEach([...tabs.values()], (tab) => tab.driver.state);
      return {
        protocol: BROWSER_HOST_PROTOCOL_VERSION,
        host: { kind: "server" },
        platform: {
          os: platform.startsWith("linux")
            ? "linux"
            : platform.startsWith("mac")
              ? "darwin"
              : "win32",
          arch: platform === "linux-arm64" || platform === "mac-arm64" ? "arm64" : "x64",
        },
        browser: { version: CHROME_VERSION, userAgent: userAgentOf(platform) },
        capabilities: {
          screencast: true,
          input: true,
          cookies: true,
          storage: true,
          indexedDb: true,
          files: true,
        },
        tabs: states,
      };
    });

    return {
      hello,
      events: Stream.fromPubSub(events).pipe(Stream.interruptWhen(Deferred.await(disconnected))),
      open,
      close,
      ...tabCalls,
      readCookies,
      writeCookies,
      readStorage,
      writeStorage,
      clearStorage,
      putFile,
      takeDownload,
      tabCount: Effect.sync(() => tabs.size),
    } satisfies ServerHost;
  });
