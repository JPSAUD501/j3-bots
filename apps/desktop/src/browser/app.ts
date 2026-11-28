// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS, type BrowserTabRef, type ServerOrigin } from "@j3-bots/contracts";
import {
  BrowserLink,
  type BrowserPlace,
  BrowserPlacement,
  BrowserPresence,
  BrowserShortcut,
  BrowserStill,
  BrowserSuggestion,
  BrowserFound,
  BrowserSuggestRequest,
  browserShortcutOf,
  DesktopBrowserCommand,
  type DesktopBrowserTab,
  DesktopBrowserState,
  type DesktopDownload,
  IPC_CHANNELS,
} from "@j3-bots/desktop-bridge";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
} from "electron";
import { electronFetch } from "../electronFetch.ts";
import { onWayland } from "../displayServer.ts";
import { type Download, makeCommand, zoomPage } from "./commands.ts";
import { recentVisits, suggestionsFor } from "./history.ts";
import { makeHistoryStore } from "./historyStore.ts";
import { type DesktopBrowser, type LocalBrowserEvent, makeDesktopBrowser } from "./host.ts";
import { linkToServer } from "./link.ts";
import { makePlaces } from "./places.ts";

// The desktop's browser in the app: it serves the server the main window's
// page is signed in to, and the app's windows show its tabs, beside the
// conversation in the main window or in the browser's own window. Each tab
// is in one place at a time; each place shows one tab in front, drawn as a
// view over the page where the page says, or as a still picture while the
// page lies over it.

const decodeLink = Schema.decodeUnknownOption(BrowserLink);
const decodeCommand = Schema.decodeUnknownOption(DesktopBrowserCommand);
const decodePlacement = Schema.decodeUnknownOption(BrowserPlacement);
const decodeSuggest = Schema.decodeUnknownOption(BrowserSuggestRequest);
const decodePresence = Schema.decodeUnknownOption(BrowserPresence);
const encodeState = Schema.encodeSync(DesktopBrowserState);
const encodeStill = Schema.encodeSync(BrowserStill);
const encodeFound = Schema.encodeSync(BrowserFound);
const encodeShortcut = Schema.encodeSync(BrowserShortcut);
const encodeSuggestions = Schema.encodeSync(Schema.Array(BrowserSuggestion));

/** How many downloads the list keeps. */
const DOWNLOADS_KEPT = 20;

/** The page's address as a tab shows it: empty for a page not loaded yet. */
const shownUrl = (contents: WebContents) => {
  const url = contents.getURL();
  return url === "about:blank" ? "" : url;
};

interface Pane {
  readonly window: BrowserWindow;
  placement: BrowserPlacement;
  /** The tab drawn as a still picture while the page covers it. */
  still: BrowserTabRef | null;
}

/**
 * Serves the desktop's browser for as long as the scope lives. `main` is
 * the main window, whose page links the browser and shows the panel; the
 * browser's own window loads `appOrigin`'s `/browser` with `preload`.
 */
export const serveBrowser = (options: {
  readonly main: BrowserWindow;
  readonly appOrigin: string;
  readonly preload: string;
  /** The script that draws the bots' pointers in the tabs' pages. */
  readonly drawing: string;
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** The server the app keeps, which alone the browser may be linked to. */
  readonly server: Effect.Effect<ServerOrigin | null>;
  /** The server the app keeps, now and as it changes. */
  readonly servers: Stream.Stream<ServerOrigin | null>;
  readonly backgroundColor: () => string;
}): Effect.Effect<DesktopBrowser, never, Scope.Scope | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userData = app.getPath("userData");
    const scratch = path.join(userData, "browser-files");
    // What a run before left: a bot's files the server never took.
    yield* fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const mac = process.platform === "darwin";

    const downloads = new Map<string, Download>();
    const panes = new Map<BrowserPlace, Pane>([
      ["panel", { window: options.main, placement: { bounds: null, covered: false }, still: null }],
    ]);
    /** The tabs a bot is typing a saved login into, by how many fills run there: each shows as a still. */
    const held = new Map<BrowserTabRef, number>();
    /** The held tabs that had the keys as the hold began, which take them back once it ends. */
    const refocus = new Set<BrowserTabRef>();
    const places = makePlaces(() => changed());
    const { order, front } = places;

    /** Whether `window` is on the person's screen: shown, and not minimized. */
    const onScreen = (window: BrowserWindow) =>
      !window.isDestroyed() && window.isVisible() && !window.isMinimized();

    const browser = yield* makeDesktopBrowser({
      // On Wayland no window is out of the person's sight: the tabs no window
      // shows wait hidden in one of the app's on their screen.
      ...(onWayland()
        ? { onScreen: () => [...panes.values()].map((pane) => pane.window).filter(onScreen) }
        : {}),
      scratch,
      drawing: options.drawing,
      downloading: (item, by, tab) => {
        const id = Buffer.from(SecureRandom.randomBytesUnsafe(12)).toString("base64url");
        const download: Download = {
          item,
          handedOver: null,
          entry: {
            id,
            name: item.getFilename().slice(0, 1024),
            received: 0,
            total: Math.max(0, item.getTotalBytes()),
            state: "progressing",
            by,
            tab,
            at: Math.floor(item.getStartTime() * 1000),
            inDownloads: by === "person",
          },
        };
        downloads.set(id, download);
        for (const old of [...downloads.keys()].slice(0, -DOWNLOADS_KEPT)) downloads.delete(old);
        const update = (state: DesktopDownload["state"]) => {
          download.entry = {
            ...download.entry,
            received: Math.max(0, item.getReceivedBytes()),
            total: Math.max(0, item.getTotalBytes()),
            state,
          };
          changed();
        };
        item.on("updated", (_event, state) =>
          update(state === "interrupted" ? "interrupted" : "progressing"),
        );
        item.once("done", (_event, state) => update(state));
        changed();
      },
      handedOver: (item, file) => {
        const download = [...downloads.values()].find((download) => download.item === item);
        if (download === undefined) return;
        download.handedOver = file;
        // One that could not be put there is lost: the list says it did not finish.
        download.entry =
          file === null
            ? { ...download.entry, state: "interrupted" }
            : { ...download.entry, inDownloads: true };
        changed();
      },
    }).pipe(Effect.orDie);

    const history = yield* makeHistoryStore(path.join(userData, "browser-history.json"));

    // -----------------------------------------------------------------------
    // What the windows show

    const paneOf = (ref: BrowserTabRef) => panes.get(places.placeOf(ref));

    const tabNow = (ref: BrowserTabRef): DesktopBrowserTab | null => {
      const tab = browser.tab(ref);
      const at = places.at(ref);
      if (tab === undefined || at === undefined || tab.contents.isDestroyed()) return null;
      const { contents } = tab;
      const url = shownUrl(contents).slice(0, 8192);
      return {
        ref,
        url,
        // A tab with no page yet has no title: Chromium's would be `about:blank`.
        title: url === "" ? "" : contents.getTitle().slice(0, 1024),
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        zoom: Math.min(500, Math.max(25, Math.round(contents.getZoomFactor() * 100))),
        private: tab.private,
        held: held.has(ref),
        place: at.place,
        failed: at.failed === null ? null : { url: at.failed.slice(0, 8192) },
        internal: url === "" ? at.internal : null,
      };
    };

    const stateNow = (): DesktopBrowserState => ({
      tabs: order.flatMap((ref) => tabNow(ref) ?? []),
      front: { ...front },
      windowOpen: panes.has("window"),
      canReopen: places.canReopen(),
      downloads: [...downloads.values()].map((download) => download.entry).toReversed(),
    });

    /**
     * Moves `window`'s tabs aside while it is off the screen, hidden or
     * minimized, and draws them in it again once it is back, with the tabs
     * the shelf kept meanwhile: a page that begins anew in a hidden window, as
     * one a navigation moves to another site does, never paints (verified on
     * Linux, Electron 44).
     */
    const shelveWhileAway = (window: BrowserWindow) => {
      const away = () => {
        browser.evacuate(window);
        changed();
      };
      const back = () => {
        browser.unshelve(window);
        changed();
      };
      window.on("hide", away);
      window.on("minimize", away);
      window.on("show", back);
      window.on("restore", back);
    };

    /** Draws each place's front tab where its window's page asked, and hides every other. */
    const draw = () => {
      // A still is of the tab in front there: one that went elsewhere, or closed, has none here.
      for (const [place, pane] of panes) {
        if (pane.still !== null && front[place] !== pane.still) pane.still = null;
      }
      for (const ref of order) {
        const pane = paneOf(ref);
        const at = places.at(ref);
        const tab = browser.tab(ref);
        if (pane === undefined || at === undefined || tab === undefined) continue;
        const { bounds } = pane.placement;
        // Something of the window over it, or a bot typing a login into it: a still, and no input.
        const covered = pane.placement.covered || held.has(ref);
        const inFront = front[at.place] === ref;
        const shows =
          inFront &&
          onScreen(pane.window) &&
          bounds !== null &&
          at.failed === null &&
          shownUrl(tab.contents) !== "";
        if (shows && covered) {
          if (pane.still !== ref) {
            pane.still = ref;
            // The picture first, then the view goes: the page never shows a hole.
            // Either way, only while it is still to be covered: what covered it may be gone by then.
            const stillCovered = () => !pane.window.isDestroyed() && pane.still === ref;
            void tab.contents.capturePage().then(
              (image) => {
                if (!stillCovered()) return;
                pane.window.webContents.send(
                  IPC_CHANNELS.browserStill,
                  encodeStill({ tab: ref, image: image.toDataURL() }),
                );
                browser.hide(ref);
              },
              () => {
                if (stillCovered()) browser.hide(ref);
              },
            );
          }
          continue;
        }
        if (pane.still === ref) pane.still = null;
        if (!shows || bounds === null) {
          browser.hide(ref);
          continue;
        }
        // The page's CSS pixels, in the window's own: the page may be zoomed.
        const scale = pane.window.webContents.getZoomFactor();
        browser.show(ref, pane.window, {
          x: Math.round(bounds.x * scale),
          y: Math.round(bounds.y * scale),
          width: Math.max(0, Math.round(bounds.width * scale)),
          height: Math.max(0, Math.round(bounds.height * scale)),
        });
        // Someone typing in the page as a bot's fill began has the keys there again.
        if (refocus.delete(ref) && pane.window.isFocused()) tab.contents.focus();
      }
    };

    let scheduled = false;
    /** Tells the windows the browser changed, once for everything that changes together. */
    const changed = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const state = encodeState(stateNow());
        for (const pane of panes.values()) {
          if (!pane.window.isDestroyed())
            pane.window.webContents.send(IPC_CHANNELS.browserChanged, state);
        }
        draw();
      });
    };
    shelveWhileAway(options.main);

    /** The tab the person looks at in `place`: none while it is not on screen. */
    const lookedAt = (place: BrowserPlace) =>
      (panes.get(place)?.placement.bounds ?? null) === null ? null : front[place];

    // -----------------------------------------------------------------------
    // The browser's own window

    const openWindow = () => {
      const existing = panes.get("window");
      if (existing !== undefined) return existing;
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 480,
        minHeight: 360,
        show: false,
        title: "J3 Bots",
        backgroundColor: options.backgroundColor(),
        autoHideMenuBar: true,
        webPreferences: {
          preload: options.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
        },
      });
      const pane: Pane = { window, placement: { bounds: null, covered: false }, still: null };
      panes.set("window", pane);
      window.once("ready-to-show", () => window.show());
      shelveWhileAway(window);
      window.on("close", () => {
        // Its tabs go beside the conversation; their views go to the shelf first.
        browser.evacuate(window);
        panes.delete("window");
        places.windowClosed();
        runFork(browser.focus(lookedAt("panel")));
        changed();
      });
      window
        .loadURL(`${options.appOrigin}/browser`)
        .catch((error: unknown) =>
          runFork(Effect.logError("Loading the browser's window failed", error)),
        );
      return pane;
    };

    const show = (ref: BrowserTabRef, place: BrowserPlace) => {
      const from = places.at(ref)?.place;
      if (place === "window") openWindow();
      places.put(ref, place, true);
      const pane = panes.get(place);
      // Sent to the other place, the tab is followed there.
      if (pane !== undefined && from !== undefined && from !== place) pane.window.focus();
      runFork(browser.focus(ref));
    };

    // -----------------------------------------------------------------------
    // Each tab, as the browser tells of it

    const follow = (event: LocalBrowserEvent) =>
      Effect.sync(() => {
        switch (event.type) {
          case "opened": {
            const { tab, opener } = event;
            places.opened(tab.ref, tab.private, opener);
            watch(tab.ref, tab.contents);
            changed();
            return;
          }
          case "changed":
            changed();
            return;
          case "held": {
            const holds = (held.get(event.tab) ?? 0) + (event.held ? 1 : -1);
            if (holds > 0) held.set(event.tab, holds);
            else held.delete(event.tab);
            if (event.held && holds === 1 && browser.tab(event.tab)?.contents.isFocused() === true)
              refocus.add(event.tab);
            changed();
            return;
          }
          case "closed": {
            const leftFront = places.closed(event.tab);
            held.delete(event.tab);
            refocus.delete(event.tab);
            // The person now looks at the tab that took its place, if that place is on screen.
            if (leftFront !== null) runFork(browser.focus(lookedAt(leftFront)));
            changed();
            return;
          }
        }
      });

    /** Listens to what a tab's page does that the windows show. */
    const watch = (ref: BrowserTabRef, contents: WebContents) => {
      const isPrivate = browser.tab(ref)?.private ?? true;
      contents.on("did-start-loading", changed);
      contents.on("did-stop-loading", changed);
      contents.on("page-title-updated", (_event, title) => {
        const url = shownUrl(contents);
        // The title a page settles on names its visit.
        const last = history.visits()[0];
        if (!isPrivate && url !== "" && last?.url === url) history.visited({ ...last, title });
        changed();
      });
      contents.on("did-navigate-in-page", changed);
      contents.on("did-start-navigation", (details) => {
        const at = places.at(ref);
        if (at !== undefined && details.isMainFrame && !details.isSameDocument) at.failed = null;
        changed();
      });
      contents.on("did-navigate", (_event, url) => {
        const at = places.at(ref);
        if (at !== undefined && url !== "about:blank") at.url = url;
        if (!isPrivate && /^https?:/.test(url)) {
          const byBot = browser.tab(ref)?.botLed() ?? false;
          runFork(
            Effect.map(Clock.currentTimeMillis, (at) =>
              history.visited({ url, title: contents.getTitle(), at, byBot }),
            ),
          );
        }
        changed();
      });
      contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
        // -3: cut short by another navigation, or stopped; not a failure to show.
        const at = places.at(ref);
        if (!isMainFrame || code === -3 || at === undefined) return;
        at.failed = url;
        changed();
      });
      contents.on("zoom-changed", (_event, direction) => {
        zoomPage(contents, direction === "in" ? "in" : "out");
        changed();
      });
      contents.on("found-in-page", (_event, result) => {
        const pane = paneOf(ref);
        if (pane === undefined || pane.window.isDestroyed()) return;
        pane.window.webContents.send(
          IPC_CHANNELS.browserFound,
          encodeFound({
            tab: ref,
            active: Math.max(0, result.activeMatchOrdinal),
            matches: Math.max(0, result.matches),
          }),
        );
      });
      // The browser's shortcuts, pressed while the page has the keys, go to its window's page.
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const shortcut = browserShortcutOf(
          {
            key: input.key,
            ctrl: input.control,
            meta: input.meta,
            shift: input.shift,
            alt: input.alt,
          },
          { mac, loading: contents.isLoading() },
        );
        const pane = paneOf(ref);
        if (shortcut === null || pane === undefined || pane.window.isDestroyed()) return;
        event.preventDefault();
        if (shortcut === "address" || shortcut === "find") pane.window.webContents.focus();
        pane.window.webContents.send(IPC_CHANNELS.browserShortcut, encodeShortcut(shortcut));
      });
    };

    yield* browser.local.pipe(Stream.runForEach(follow), Effect.forkScoped);

    // -----------------------------------------------------------------------
    // The person's commands

    const command = makeCommand({
      browser,
      places,
      downloads,
      show,
      closeWindow: () => panes.get("window")?.window.close(),
      changed,
      runFork,
    });

    // -----------------------------------------------------------------------
    // The link to the server

    const link = yield* FiberHandle.make<void, never>();
    let linkedAs: {
      readonly server: ServerOrigin;
      readonly key: string;
      readonly token: Redacted.Redacted<string>;
    } | null = null;
    /** Whether `server` no longer takes `token`: its socket ticket says so. */
    const refuses = (server: ServerOrigin, token: Redacted.Redacted<string>) =>
      Effect.promise(() =>
        electronFetch(new URL(HTTP_PATHS.socketTicket, server).href, {
          method: "POST",
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        }).then(
          (response) => response.status === 401,
          () => false,
        ),
      );
    const unlink = Effect.suspend(() => {
      linkedAs = null;
      return FiberHandle.clear(link);
    });
    // A server the app no longer keeps loses the browser at once, whatever its token.
    yield* options.servers.pipe(
      Stream.runForEach((server) =>
        linkedAs !== null && linkedAs.server !== server ? unlink : Effect.void,
      ),
      Effect.forkScoped,
    );
    // A device the server no longer takes keeps none of its sign-ins: one not emptied now is
    // emptied as the browser next starts.
    const forgetSignIns = browser.forgetSignIns.pipe(
      Effect.catch((error) =>
        Effect.logError("The sign-ins of a device the server no longer takes stay for now", error),
      ),
    );
    const linkTo = Effect.fn("DesktopBrowser.linkTo")(function* (asked: BrowserLink) {
      if (asked === null) {
        const was = linkedAs;
        yield* unlink;
        // The page may hear of a revoked device before the link does: the sign-ins go all the
        // same, unless the browser was linked again meanwhile, and they are that link's now.
        if (was !== null && (yield* refuses(was.server, was.token)) && linkedAs === null) {
          yield* forgetSignIns;
        }
        return;
      }
      // Only the server the app keeps: a page cannot point the browser anywhere else.
      if ((yield* options.server) !== asked.server) return;
      const key = `${asked.server} ${asked.deviceId} ${asked.token}`;
      if (key === linkedAs?.key) return;
      const token = Redacted.make<string>(asked.token);
      linkedAs = { server: asked.server, key, token };
      yield* FiberHandle.run(
        link,
        linkToServer({
          origin: asked.server,
          token,
          host: browser.hostFor(asked.deviceId),
          refused: refuses(asked.server, token),
          onRefused: Effect.andThen(
            forgetSignIns,
            Effect.sync(() => {
              linkedAs = null;
            }),
          ),
          ended: (end) => Effect.logDebug("The browser's link to the server ended", end),
        }),
      );
    });

    // -----------------------------------------------------------------------
    // The windows' pages

    /** The place whose window `event` came from, if it is one of the app's own pages there. */
    const senderPlace = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserPlace | null => {
      if (!options.fromApp(event)) return null;
      for (const [place, pane] of panes) {
        if (!pane.window.isDestroyed() && pane.window.webContents === event.sender) return place;
      }
      return null;
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.on(IPC_CHANNELS.browserLink, (event, raw: unknown) => {
          const decoded = decodeLink(raw);
          // The main window's page is the one signed in to the server.
          if (senderPlace(event) !== "panel" || Option.isNone(decoded)) return;
          runFork(linkTo(decoded.value));
        });
        ipcMain.handle(IPC_CHANNELS.browserState, (event) =>
          senderPlace(event) === null ? null : encodeState(stateNow()),
        );
        ipcMain.on(IPC_CHANNELS.browserCommand, (event, raw: unknown) => {
          const decoded = decodeCommand(raw);
          if (senderPlace(event) !== null && Option.isSome(decoded)) command(decoded.value);
        });
        ipcMain.on(IPC_CHANNELS.browserPlace, (event, raw: unknown) => {
          const place = senderPlace(event);
          const decoded = decodePlacement(raw);
          const pane = place === null ? undefined : panes.get(place);
          if (pane === undefined || Option.isNone(decoded)) return;
          pane.placement = decoded.value;
          draw();
        });
        // Only the main window's page: its conversation's client knows who is on the tabs.
        ipcMain.on(IPC_CHANNELS.browserPresence, (event, raw: unknown) => {
          const decoded = decodePresence(raw);
          if (senderPlace(event) === "panel" && Option.isSome(decoded)) {
            runFork(browser.presence(decoded.value));
          }
        });
        ipcMain.handle(IPC_CHANNELS.browserSuggest, (event, raw: unknown) => {
          const decoded = decodeSuggest(raw);
          if (senderPlace(event) === null || Option.isNone(decoded)) return null;
          const shared = order.flatMap((ref) => {
            const tab = tabNow(ref);
            return tab === null || tab.private ? [] : [tab];
          });
          return encodeSuggestions(
            decoded.value.recent === true
              ? recentVisits(history.visits())
              : suggestionsFor(decoded.value.text, shared, history.visits()),
          );
        });
      }),
      () =>
        Effect.sync(() => {
          ipcMain.removeAllListeners(IPC_CHANNELS.browserLink);
          ipcMain.removeHandler(IPC_CHANNELS.browserState);
          ipcMain.removeAllListeners(IPC_CHANNELS.browserPresence);
          ipcMain.removeAllListeners(IPC_CHANNELS.browserCommand);
          ipcMain.removeAllListeners(IPC_CHANNELS.browserPlace);
          ipcMain.removeHandler(IPC_CHANNELS.browserSuggest);
        }),
    );
    // A page that loads again starts with nothing placed, and knows of no bot on a tab.
    options.main.webContents.on("did-start-navigation", (details) => {
      const pane = panes.get("panel");
      if (pane !== undefined && details.isMainFrame && !details.isSameDocument) {
        pane.placement = { bounds: null, covered: false };
        draw();
        runFork(browser.presence([]));
      }
    });
    // Nor does a page that is gone.
    options.main.webContents.on("render-process-gone", () => {
      runFork(browser.presence([]));
    });

    return browser;
  });
