// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron asks where a download goes, and tells that it finished, in callbacks that want an answer at once.
// Placing a download by who began it follows T3 Code v0.1.13,
// apps/desktop/src/preview/DesktopBrowserHost.ts (`placeDownload`, MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see apps/desktop/NOTICE). Changed here: a bot's
// download is kept for the server to take, and the person's goes to their downloads
// folder without a dialog.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { driverTabCalls, type PageHost } from "@j3-bots/browser";
import {
  BROWSER_HOST_PROTOCOL_VERSION,
  type BrowserCookie,
  BrowserDownloadId,
  BrowserHostError,
  type BrowserHostEvent,
  BrowserPageState,
  BrowserTabRef,
  type DeviceId,
  MAX_ATTACHMENT_SIZE,
} from "@j3-bots/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  app,
  BaseWindow,
  type DownloadItem,
  type Rectangle,
  type Session,
  session as electronSession,
  type WebContents,
  WebContentsView,
  webContents as allWebContents,
} from "electron";
import { cookieChanges, cookieId, keyOfCookie, withCookieChanges } from "./cookies.ts";
import { freeName, savedName } from "./files.ts";
import {
  type Identity,
  type IdentityArch,
  type IdentityPlatform,
  identityOf,
  withNavigationHints,
} from "./identity.ts";
import { BROWSER_PARTITION, PRIVATE_PARTITION_PREFIX, pageMayGo, pageMayHave } from "./policy.ts";
import { makeSignIns, type SignIns } from "./probe.ts";
import { type DesktopTab, takeTab } from "./tab.ts";

// The desktop app's own browser (decision 0110): tabs in views of the app,
// in one persistent partition that holds the shared sign-ins, which the J3
// Bots server drives through the page host protocol. A private tab has a
// partition of its own, in memory, that it forgets as it closes.

/** What happened to a tab, as the app's own view of the browser hears it: private tabs too. */
export type LocalBrowserEvent =
  | {
      readonly type: "opened";
      readonly tab: DesktopTab;
      readonly opener: BrowserTabRef | null;
      readonly background: boolean;
    }
  | { readonly type: "changed"; readonly tab: DesktopTab; readonly page: BrowserPageState }
  | { readonly type: "closed"; readonly tab: BrowserTabRef };

/** The desktop's browser, for the server's link and for the app's own view of it. */
export interface DesktopBrowser {
  /** The page host the server drives, as the device `device`. */
  readonly hostFor: (device: DeviceId) => PageHost;
  readonly tab: (ref: BrowserTabRef) => DesktopTab | undefined;
  readonly tabs: () => ReadonlyArray<DesktopTab>;
  readonly local: Stream.Stream<LocalBrowserEvent>;
  /** A tab the person opens in the app, at `url` or blank. */
  readonly openForPerson: (options: {
    readonly url?: string | undefined;
    readonly private: boolean;
    readonly opener?: BrowserTabRef | undefined;
  }) => Effect.Effect<DesktopTab, BrowserHostError>;
  readonly close: (ref: BrowserTabRef) => Effect.Effect<void>;
  /** The tab the person has in front of them, or none. */
  readonly focus: (ref: BrowserTabRef | null) => Effect.Effect<void>;
  /**
   * Shows the tab in `window` at `bounds`, in the window's own coordinates,
   * moving its view there if another window had it.
   */
  readonly show: (ref: BrowserTabRef, window: BaseWindow, bounds: Rectangle) => void;
  /** Hides the tab's view where it is: a hidden view keeps its page, and paints when watched. */
  readonly hide: (ref: BrowserTabRef) => void;
  /** Moves every tab `window` holds to the hidden shelf, before the window goes. */
  readonly evacuate: (window: BaseWindow) => void;
  /** The person used the tab from the app's own controls: its address, back or forward. */
  readonly personUsed: (ref: BrowserTabRef) => Effect.Effect<void>;
  /** Empties the shared sign-ins: the server no longer takes this device. */
  readonly forgetSignIns: Effect.Effect<void>;
}

/** How long cookie changes gather before they are sent: a sign-in sets many at once. */
const COOKIE_BATCH_MS = 1_000;
/** How often the storage of the shared tabs' origins is offered to read again. */
const STORAGE_EVERY_MS = 5 * 60_000;

/** 128 random bits, as the protocol asks of a ref a host mints. */
const randomId = (bytes = 16) =>
  Buffer.from(SecureRandom.randomBytesUnsafe(bytes)).toString("base64url");
/**
 * The size of a tab no window shows: its page's viewport. The shelf is
 * hidden, and a hidden window has no content size to take it from.
 */
const SHELF_SIZE = { width: 1280, height: 800 };

const mintRef = () => BrowserTabRef.make(randomId());
const mintDownload = () => BrowserDownloadId.make(randomId());
const samePage = Schema.toEquivalence(BrowserPageState);

const failed = (reason: BrowserHostError["reason"], detail?: string) =>
  new BrowserHostError(
    detail === undefined ? { reason } : { reason, detail: detail.slice(0, 500) },
  );

const platformOf = (): IdentityPlatform =>
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
const archOf = (): IdentityArch => (process.arch === "arm64" ? "arm64" : "x64");

/**
 * The system's version, as the high-entropy hint carries it: the kernel's
 * release on Linux, the system's own version elsewhere.
 */
const platformVersion = () =>
  process.platform === "linux"
    ? (/^\d+\.\d+\.\d+/.exec(NodeOS.release())?.[0] ?? "")
    : process.getSystemVersion();

/** The `WebContents` Electron hands a pop-up to adopt, found by its id: Electron's types leave it out. */
const adoptable = (options: object): WebContents | undefined => {
  if (!("webContents" in options)) return undefined;
  const given = options.webContents;
  if (
    typeof given !== "object" ||
    given === null ||
    !("id" in given) ||
    typeof given.id !== "number"
  ) {
    return undefined;
  }
  return allWebContents.fromId(given.id);
};

/** The sessions of the browser's partitions, shared and private. */
const browserSessions = new WeakSet<Session>();

/** Whether `session` is one of the browser's: its pages are the browser's tabs, not the app's. */
export const isBrowserSession = (session: Session): boolean => browserSessions.has(session);

/** The partition's session, made ready for pages: permissions, identity and client hints. */
const prepareSession = (session: Session, identity: Identity) => {
  browserSessions.add(session);
  session.setUserAgent(identity.userAgent);
  session.setPermissionRequestHandler((_contents, permission, grant) =>
    grant(pageMayHave(permission)),
  );
  session.setPermissionCheckHandler((_contents, permission) => pageMayHave(permission));
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, answer) => answer({}));
  session.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, answer) => {
      const requestHeaders = withNavigationHints(identity, details);
      answer(requestHeaders === null ? {} : { requestHeaders });
    },
  );
};

interface Entry {
  readonly tab: DesktopTab;
  readonly session: Session;
  readonly scope: Scope.Closeable;
  /** Whether the server hears of it: every shared tab, and a private one only if the server opened it. */
  readonly reported: boolean;
  /** The tab's files for a bot's upload. */
  readonly files: string;
  ended: boolean;
}

/**
 * The desktop's browser, for as long as the scope lives. A tab is born
 * hidden in a window that is never shown, and the app shows it where it
 * wants (`show`). `scratch` is a folder of its own for the files the
 * browser keeps for a moment: a bot's uploads and downloads.
 */
export const makeDesktopBrowser = (options: {
  readonly scratch: string;
  /** Told of each download as it begins: the person's, or a bot's on `tab`. */
  readonly downloading?: (
    item: DownloadItem,
    by: "person" | "bot",
    tab: BrowserTabRef | null,
  ) => void;
  /** Told that a bot's download, too large for the server, is now the person's: at `file`, in their downloads. */
  readonly handedOver?: (item: DownloadItem, file: string) => void;
}): Effect.Effect<DesktopBrowser, BrowserHostError, Scope.Scope> =>
  Effect.gen(function* () {
    const hostScope = yield* Effect.scope;
    const identity = identityOf({
      chromeVersion: process.versions.chrome,
      platform: platformOf(),
      arch: archOf(),
      platformVersion: platformVersion(),
    });
    const shared = electronSession.fromPartition(BROWSER_PARTITION);
    prepareSession(shared, identity);

    // The window tabs no other window shows live in, hidden: a tab in it
    // still paints while it is watched or driven.
    const shelf = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const window = new BaseWindow({
          show: false,
          x: -32_000,
          y: -32_000,
          ...SHELF_SIZE,
          skipTaskbar: true,
          focusable: false,
        });
        // Shown once, out of sight: a window never shown draws nothing at all,
        // while one hidden after it was shown paints when asked (verified on Electron 44).
        window.showInactive();
        window.hide();
        return window;
      }),
      (window) => Effect.sync(() => window.destroy()),
    );
    const signIns: SignIns = yield* makeSignIns(shared, shelf);

    const toServer = yield* PubSub.unbounded<BrowserHostEvent>();
    const toApp = yield* PubSub.unbounded<LocalBrowserEvent>();
    const entries = new Map<BrowserTabRef, Entry>();
    /** The window each tab's view is in. A view never leaves a window: out of one it stops painting. */
    const homes = new Map<WebContentsView, BaseWindow>();
    const moveTo = (view: WebContentsView, window: BaseWindow) => {
      const was = homes.get(view);
      if (was === window) return;
      if (was !== undefined && !was.isDestroyed()) was.contentView.removeChildView(view);
      window.contentView.addChildView(view);
      homes.set(view, window);
    };
    /** The drivers of the tabs the server knows of. */
    const drivers = new Map<BrowserTabRef, DesktopTab["driver"]>();
    const downloads = new Map<BrowserDownloadId, string>();

    const tell = (event: BrowserHostEvent) => PubSub.publish(toServer, event);
    const tellApp = (event: LocalBrowserEvent) => PubSub.publish(toApp, event);
    // For Electron's callbacks, which run outside any fiber.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const run = <A, E>(effect: Effect.Effect<A, E>) => runFork(Effect.ignore(effect));

    // -----------------------------------------------------------------------
    // Sign-ins: what the sites change is sent, what the server writes is not.

    let known = new Map<string, BrowserCookie>(
      (yield* signIns.readCookies).map((cookie) => [cookieId(keyOfCookie(cookie)), cookie]),
    );
    let gathering: Fiber.Fiber<void, BrowserHostError> | undefined;
    const sendCookieChanges = Effect.gen(function* () {
      yield* Effect.sleep(COOKIE_BATCH_MS);
      gathering = undefined;
      const changes = cookieChanges(known, yield* signIns.readCookies);
      known = withCookieChanges(known, changes);
      if (changes.set.length > 0 || changes.removed.length > 0) {
        yield* tell({ type: "cookies.changed", changes });
      }
    });
    // The event only says to look: Electron's cookie loses a partition's key.
    shared.cookies.on("changed", () => {
      gathering ??= runFork(sendCookieChanges);
    });

    const originOf = (url: string) => {
      const parsed = URL.parse(url);
      return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:")
        ? parsed.origin
        : null;
    };
    const tellStorage = (origins: ReadonlyArray<string | null>) => {
      const named = [...new Set(origins.filter((origin) => origin !== null))];
      return named.length === 0 ? Effect.void : tell({ type: "storage.changed", origins: named });
    };
    const sharedOrigins = () =>
      [...entries.values()]
        .filter((entry) => !entry.tab.private)
        .map((entry) => originOf(entry.tab.contents.getURL()));
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(
          Effect.sleep(STORAGE_EVERY_MS),
          Effect.suspend(() => tellStorage(sharedOrigins())),
        ),
      ),
    );

    // -----------------------------------------------------------------------
    // Downloads: a bot's is kept for the server, the person's goes to them.

    const entryOf = (contents: WebContents) =>
      [...entries.values()].find((entry) => entry.tab.contents === contents);

    const personDownload = (item: DownloadItem, tab: BrowserTabRef | null) => {
      options.downloading?.(item, "person", tab);
      const folder = app.getPath("downloads");
      item.setSavePath(
        NodePath.join(
          folder,
          freeName(savedName(item.getFilename()), (name) =>
            NodeFS.existsSync(NodePath.join(folder, name)),
          ),
        ),
      );
    };
    const onDownload = (_event: Electron.Event, item: DownloadItem, source: WebContents) => {
      const entry = entryOf(source);
      if (entry === undefined || !entry.reported || entry.tab.private || !entry.tab.botLed()) {
        personDownload(item, entry?.tab.ref ?? null);
        return;
      }
      options.downloading?.(item, "bot", entry.tab.ref);
      const download = mintDownload();
      const name = savedName(item.getFilename());
      const folder = NodePath.join(options.scratch, "downloads", download);
      NodeFS.mkdirSync(folder, { recursive: true });
      const file = NodePath.join(folder, name);
      item.setSavePath(file);
      /** Whether the server takes the finished file; if not, it is the person's. */
      const forServer = () => {
        const size = NodeFS.statSync(file).size;
        // Too large for the server to keep: it stays with the person instead.
        if (size > MAX_ATTACHMENT_SIZE) {
          const mine = app.getPath("downloads");
          const target = NodePath.join(
            mine,
            freeName(name, (candidate) => NodeFS.existsSync(NodePath.join(mine, candidate))),
          );
          // A copy where a move cannot cross from one disk to another.
          NodeFS.cpSync(file, target, { errorOnExist: true, force: false });
          options.handedOver?.(item, target);
          return false;
        }
        downloads.set(download, folder);
        run(tell({ type: "download.finished", tab: entry.tab.ref, download, name, size }));
        return true;
      };
      item.once("done", (_done, state) => {
        // Thrown in Electron's listener, an error would take the app down: the file is let go instead.
        const kept = Result.try(() => state === "completed" && forServer());
        if (Result.isFailure(kept)) {
          run(Effect.logWarning("A bot's download could not be kept", kept.failure));
        }
        if (Result.isFailure(kept) || !kept.success) {
          NodeFS.rmSync(folder, { recursive: true, force: true });
        }
      });
    };
    shared.on("will-download", onDownload);

    // -----------------------------------------------------------------------
    // Tabs

    /** A new tab's view, hidden in the shelf at the shelf's size, so its page has a viewport. */
    const viewFor = (session: Session, adopted?: WebContents) => {
      const view = new WebContentsView({
        ...(adopted === undefined ? {} : { webContents: adopted }),
        webPreferences: {
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
        },
      });
      view.setVisible(false);
      view.setBounds({ x: 0, y: 0, ...SHELF_SIZE });
      moveTo(view, shelf);
      return view;
    };

    const ended = Effect.fn("DesktopBrowser.ended")(function* (entry: Entry, crashed: boolean) {
      if (entry.ended) return;
      entry.ended = true;
      entries.delete(entry.tab.ref);
      drivers.delete(entry.tab.ref);
      const { contents } = entry.tab;
      if (!entry.tab.private && !contents.isDestroyed())
        yield* tellStorage([originOf(contents.getURL())]);
      yield* Scope.close(entry.scope, Exit.void);
      const home = homes.get(entry.tab.view);
      homes.delete(entry.tab.view);
      if (home !== undefined && !home.isDestroyed())
        home.contentView.removeChildView(entry.tab.view);
      if (!contents.isDestroyed()) contents.close();
      NodeFS.rmSync(entry.files, { recursive: true, force: true });
      // A private partition is forgotten with the last tab in it.
      if (
        entry.tab.private &&
        ![...entries.values()].some((other) => other.session === entry.session)
      ) {
        yield* Effect.promise(() => entry.session.clearData().catch(() => undefined));
      }
      if (entry.reported) yield* tell({ type: "tab.closed", tab: entry.tab.ref, crashed });
      yield* tellApp({ type: "closed", tab: entry.tab.ref });
    });

    /** Makes `view` the tab `ref` and tells who should hear of it. */
    const adopt: (input: {
      readonly ref: BrowserTabRef;
      readonly view: WebContentsView;
      readonly private: boolean;
      readonly reported: boolean;
      readonly adopted: boolean;
      readonly opener: DesktopTab | null;
      readonly background: boolean;
      /** Told the server as a tab the host opened by itself. */
      readonly announce: boolean;
    }) => Effect.Effect<DesktopTab, BrowserHostError> = Effect.fn("DesktopBrowser.adopt")(
      function* (input) {
        const scope = yield* Scope.fork(hostScope);
        const contents = input.view.webContents;
        let current: Entry | undefined;
        const tab = yield* takeTab({
          ref: input.ref,
          private: input.private,
          view: input.view,
          identity,
          adopted: input.adopted,
          events: {
            personInput: () => {
              if (current?.reported === true) run(tell({ type: "person.input", tab: input.ref }));
            },
          },
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() =>
            Effect.andThen(
              Scope.close(scope, Exit.void),
              Effect.sync(() => {
                if (!contents.isDestroyed()) contents.close();
              }),
            ),
          ),
        );
        const files = NodePath.join(options.scratch, "files", randomId(8));
        const entry: Entry = {
          tab,
          session: contents.session,
          scope,
          reported: input.reported,
          files,
          ended: false,
        };
        current = entry;
        entries.set(tab.ref, entry);
        if (entry.reported) drivers.set(tab.ref, tab.driver);

        // What the page does by itself, once its opening is told.
        let last = yield* tab.driver.state;
        const changed = Effect.fn("DesktopBrowser.changed")(function* (page: BrowserPageState) {
          if (samePage(page, last)) return;
          last = page;
          if (entry.reported) yield* tell({ type: "tab.changed", page });
          yield* tellApp({ type: "changed", tab, page });
        });
        if (input.announce && entry.reported) {
          yield* tell({
            type: "tab.opened",
            page: last,
            opener: input.opener?.ref ?? null,
            private: tab.private,
          });
        }
        yield* tellApp({
          type: "opened",
          tab,
          opener: input.opener?.ref ?? null,
          background: input.background,
        });
        yield* tab.driver.changes.pipe(Stream.runForEach(changed), Effect.forkIn(scope));
        contents.on("page-title-updated", () => run(Effect.flatMap(tab.driver.state, changed)));
        contents.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument && !tab.private) {
            const leaving = originOf(contents.getURL());
            if (leaving !== null && leaving !== originOf(details.url)) run(tellStorage([leaving]));
          }
        });
        contents.on("render-process-gone", () => run(ended(entry, true)));
        contents.once("destroyed", () => run(ended(entry, false)));
        contents.setWindowOpenHandler(({ url }) =>
          pageMayGo(url) || url === ""
            ? {
                action: "allow",
                outlivesOpener: true,
                // The pop-up keeps `window.opener`: Electron's own new page is adopted into a view.
                createWindow: (created) => {
                  const popup = viewFor(contents.session, adoptable(created));
                  run(
                    adopt({
                      ref: mintRef(),
                      view: popup,
                      private: tab.private,
                      reported: entry.reported,
                      adopted: true,
                      opener: tab,
                      background: false,
                      announce: true,
                    }),
                  );
                  return popup.webContents;
                },
              }
            : { action: "deny" },
        );

        return tab;
      },
    );

    const newPrivateSession = () => {
      const session = electronSession.fromPartition(`${PRIVATE_PARTITION_PREFIX}${randomId()}`);
      prepareSession(session, identity);
      session.on("will-download", (_event, item, source) =>
        personDownload(item, entryOf(source)?.tab.ref ?? null),
      );
      return session;
    };

    const openTab = (input: {
      readonly ref: BrowserTabRef;
      readonly private: boolean;
      readonly reported: boolean;
      readonly opener: DesktopTab | null;
      readonly background: boolean;
      readonly announce: boolean;
    }) =>
      adopt({
        ...input,
        // A private tab a page opens shares its opener's partition, as a browser's private window does.
        view: viewFor(
          input.private ? (input.opener?.contents.session ?? newPrivateSession()) : shared,
        ),
        adopted: false,
      });

    // -----------------------------------------------------------------------
    // The page host the server drives

    const reported = () => [...entries.values()].filter((entry) => entry.reported && !entry.ended);
    const pointer = (event: Extract<BrowserHostEvent, { readonly type: "pointer" }>) => tell(event);
    const tabCalls = driverTabCalls(drivers, pointer);
    const paintingWhile = <A>(ref: BrowserTabRef, effect: Effect.Effect<A, BrowserHostError>) =>
      Effect.suspend(() => {
        const entry = entries.get(ref);
        return entry === undefined ? effect : entry.tab.painting(effect);
      });

    const hostFor = (device: DeviceId): PageHost => ({
      hello: Effect.gen(function* () {
        const tabs = yield* Effect.forEach(
          reported().filter((entry) => !entry.tab.private),
          (entry) => entry.tab.driver.state,
        );
        return {
          protocol: BROWSER_HOST_PROTOCOL_VERSION,
          host: { kind: "desktop", device },
          platform: { os: platformOf(), arch: archOf() },
          browser: { version: process.versions.chrome, userAgent: identity.userAgent },
          capabilities: {
            screencast: true,
            input: true,
            cookies: true,
            storage: true,
            files: true,
            privateTabs: true,
            nativeView: true,
          },
          tabs,
        };
      }),
      events: Stream.fromPubSub(toServer),
      open: Effect.fn("DesktopBrowser.open")(function* (input) {
        const existing = entries.get(input.tab);
        if (existing !== undefined) return yield* existing.tab.driver.state;
        const tab = yield* openTab({
          ref: input.tab,
          private: input.private,
          reported: true,
          opener: null,
          background: input.background,
          announce: false,
        });
        if (input.url === undefined) return yield* tab.driver.state;
        return yield* tab.painting(
          tab.driver.navigate(
            { kind: "url", url: input.url },
            { readiness: input.readiness, timeoutMs: input.timeoutMs },
          ),
        );
      }),
      close: (ref) =>
        Effect.suspend(() => {
          const entry = entries.get(ref);
          return entry === undefined || !entry.reported ? Effect.void : ended(entry, false);
        }),
      ...tabCalls,
      navigate: (input) => paintingWhile(input.tab, tabCalls.navigate(input)),
      act: (input) => paintingWhile(input.tab, tabCalls.act(input)),
      evaluate: (input) => paintingWhile(input.tab, tabCalls.evaluate(input)),
      waitFor: (input) => paintingWhile(input.tab, tabCalls.waitFor(input)),
      snapshot: (input) => paintingWhile(input.tab, tabCalls.snapshot(input)),
      screenshot: (input) => paintingWhile(input.tab, tabCalls.screenshot(input)),
      screencast: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Painting for as long as someone watches, though the tab is hidden.
            const entry = entries.get(input.tab);
            if (entry?.reported === true) yield* entry.tab.paint;
            return tabCalls.screencast(input);
          }),
        ),
      putFile: ({ tab, name, bytes }) =>
        Effect.suspend(() => {
          const entry = entries.get(tab);
          if (entry === undefined || !entry.reported) return Effect.fail(failed("no-tab"));
          return Effect.try({
            try: () => {
              const folder = NodePath.join(entry.files, randomId(8));
              NodeFS.mkdirSync(folder, { recursive: true });
              const path = NodePath.join(folder, savedName(name));
              NodeFS.writeFileSync(path, bytes);
              return { path };
            },
            catch: (cause) => failed("page", `The file was not kept: ${String(cause)}`),
          });
        }),
      takeDownload: ({ download }) =>
        Effect.suspend(() => {
          const folder = downloads.get(download);
          if (folder === undefined)
            return Effect.fail(failed("invalid-target", "No such download waits."));
          downloads.delete(download);
          return Effect.try({
            try: () => {
              const [name] = NodeFS.readdirSync(folder);
              if (name === undefined) throw new Error("The download's file is gone.");
              return { bytes: new Uint8Array(NodeFS.readFileSync(NodePath.join(folder, name))) };
            },
            catch: (cause) => failed("invalid-target", String(cause)),
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
            ),
          );
        }),
      readCookies: Effect.map(signIns.readCookies, (cookies) => ({ cookies })),
      writeCookies: (changes) =>
        Effect.suspend(() => {
          // Known first: the writes' own `changed` events then find nothing new.
          known = withCookieChanges(known, changes);
          return signIns.writeCookies(changes);
        }),
      readStorage: ({ origins }) =>
        Effect.map(signIns.readStorage(origins), (read) => ({ origins: read })),
      writeStorage: (origins) => signIns.writeStorage(origins),
    });

    // -----------------------------------------------------------------------
    // The app's own view

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.forEach([...entries.values()], (entry) => ended(entry, false), {
          discard: true,
        });
        for (const [, folder] of downloads) NodeFS.rmSync(folder, { recursive: true, force: true });
        shared.off("will-download", onDownload);
      }),
    );

    return {
      hostFor,
      tab: (ref) => entries.get(ref)?.tab,
      tabs: () => [...entries.values()].map((entry) => entry.tab),
      local: Stream.fromPubSub(toApp),
      openForPerson: Effect.fn("DesktopBrowser.openForPerson")(function* ({
        url,
        private: isPrivate,
        opener,
      }) {
        if (url !== undefined && !pageMayGo(url))
          return yield* failed("refused", "A tab cannot show that address.");
        const from = opener === undefined ? null : (entries.get(opener)?.tab ?? null);
        const tab = yield* openTab({
          ref: mintRef(),
          private: isPrivate,
          // A private tab the person opens is never the server's to know.
          reported: !isPrivate,
          opener: from,
          background: false,
          announce: true,
        });
        // A page that fails to load shows its error in the tab.
        if (url !== undefined)
          yield* Effect.promise(() => tab.contents.loadURL(url).catch(() => undefined));
        return tab;
      }),
      close: (ref) =>
        Effect.suspend(() => {
          const entry = entries.get(ref);
          return entry === undefined ? Effect.void : ended(entry, false);
        }),
      focus: (ref) =>
        Effect.suspend(() => {
          const entry = ref === null ? undefined : entries.get(ref);
          // A private tab in front is none the server may know of.
          return tell({
            type: "tab.focused",
            tab: entry?.reported === true ? entry.tab.ref : null,
          });
        }),
      show: (ref, window, bounds) => {
        const view = entries.get(ref)?.tab.view;
        if (view === undefined) return;
        moveTo(view, window);
        view.setBounds(bounds);
        view.setVisible(true);
      },
      hide: (ref) => entries.get(ref)?.tab.view.setVisible(false),
      evacuate: (window) => {
        for (const [view, home] of homes) {
          if (home !== window) continue;
          view.setVisible(false);
          view.setBounds({ x: 0, y: 0, ...SHELF_SIZE });
          moveTo(view, shelf);
        }
      },
      personUsed: (ref) =>
        Effect.suspend(() =>
          entries.get(ref)?.reported === true
            ? tell({ type: "person.input", tab: ref })
            : Effect.void,
        ),
      forgetSignIns: Effect.gen(function* () {
        yield* Effect.promise(() => shared.clearData().catch(() => undefined));
        known = new Map();
      }),
    };
  });
