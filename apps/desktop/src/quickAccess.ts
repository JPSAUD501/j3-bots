// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId } from "@j3-bots/contracts";
import {
  type Destination,
  IPC_CHANNELS,
  QUICK_ACCESS_PATH,
  QuickAccessCue,
  QuickAccessHide,
  QuickAccessOpen,
  QuickAccessReport,
} from "@j3-bots/desktop-bridge";
import { colors } from "@j3-bots/design-tokens";
import { hexColor } from "@j3-bots/design-tokens/raster";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  nativeTheme,
  screen,
} from "electron";
import {
  cornerOffset,
  defaultOffset,
  placeOn,
  quickAccessBounds,
  quickAccessSize,
  shortcutStep,
  withPlace,
} from "./quickAccessPlace.ts";
import { DesktopSettings } from "./settings.ts";

// Quick access: a small window on the primary bot's conversation, which the
// global shortcut opens and closes. It has no frame and, where the desktop
// composites its windows, is see-through around a rounded card; it stands
// above the other windows while it shows, is not listed in the taskbar, and
// is dragged by the card's header, which the page marks as the window's
// handle. The window is made once and kept hidden, its page loaded and
// following the server, so the shortcut only has to show it.
//
// Its page is the web client's own, at `/quick`, under the preload script and
// the navigation rules of the main window. Three things only that page may
// ask: say whether it has a bot to show, hide the window, and open the main
// window at the bot's conversation.

const decodeReport = Schema.decodeUnknownOption(QuickAccessReport);
const decodeOpen = Schema.decodeUnknownOption(QuickAccessOpen);
const decodeHide = Schema.decodeUnknownOption(QuickAccessHide);
const encodeCue = Schema.encodeSync(QuickAccessCue);

/** How long the page has to go out before the window is hidden under it. */
const LEAVE_WITHIN = Duration.millis(600);
/** How long after the window last moved its place is kept: a drag reports many moves. */
const SETTLED_AFTER = Duration.millis(250);

interface Options {
  /** The app's window, which quick access lives beside and goes with. */
  readonly main: BrowserWindow;
  /** The origin of the app's pages. */
  readonly appOrigin: string;
  /** The preload script, the main window's own. */
  readonly preload: string;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Whether a transparent window shows what is behind it here (`transparencyHere`). */
  readonly transparent: boolean;
  /** On Wayland the compositor places windows: the app neither sets nor reads where one stands. */
  readonly wayland: boolean;
  /** Shows the main window with the cursor in its composer: what the shortcut does while quick access has nothing to show. */
  readonly showMain: () => void;
  /** Shows the main window at `target`, under the pairing that listed it. */
  readonly openInMain: (target: Destination, pairing: DeviceId) => void;
}

interface QuickAccess {
  /** What the global shortcut does: opens quick access, or closes it while the cursor is in it. */
  readonly toggle: () => void;
  /**
   * Takes its page off the window, with everything that page held open, as
   * the storage it shares with the main window's: done once that is so. The
   * page comes back the next time the main window's loads.
   */
  readonly unload: Effect.Effect<void>;
}

/** The card's color in the theme the app is in, which a window that is not see-through fills with. */
const cardColor = () =>
  hexColor(colors.surface[nativeTheme.shouldUseDarkColors ? "dark" : "light"]);

/** Keeps the quick access window, hidden until asked for, while the scope lasts. */
export const serve = Effect.fn("desktop.quickAccess")(function* ({
  main,
  appOrigin,
  preload,
  fromApp,
  transparent,
  wayland,
  showMain,
  openInMain,
}: Options) {
  const settings = yield* DesktopSettings;
  const context = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);
  /** Runs `then` once `wait` has passed, unless the fiber this answers is interrupted first. */
  const after = (wait: Duration.Duration, then: () => void) =>
    runFork(Effect.sleep(wait).pipe(Effect.andThen(Effect.sync(then))));
  const cancel = (waiting: Fiber.Fiber<void> | null) => {
    if (waiting !== null) runFork(Fiber.interrupt(waiting));
  };
  const solid = !transparent;
  const size = quickAccessSize(solid);
  const url = `${appOrigin}${QUICK_ACCESS_PATH}${solid ? "?solid=true" : ""}`;

  const { toggle, unload } = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const window = new BrowserWindow({
        ...size,
        show: false,
        frame: false,
        transparent,
        // What shows before the page paints, and through it where it is see-through.
        backgroundColor: solid ? cardColor() : "#00000000",
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        title: "J3 Bots",
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
        },
      });

      /** Whether the page has a primary bot to show. */
      let available = false;
      /** The page was told to leave, and the window hides once it has, or once this runs out. */
      let leaving: Fiber.Fiber<void> | null = null;
      /** The app moves the window itself: what moves it then is not the operator. */
      let placing = false;
      let settling: Fiber.Fiber<void> | null = null;
      let gone = false;

      const fromQuickAccess = (event: IpcMainEvent) =>
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        fromApp(event) &&
        URL.parse(event.senderFrame?.url ?? "")?.pathname === QUICK_ACCESS_PATH;

      /**
       * Counts each time the window is shown or brought back to hand. The
       * page names the one it went out of as it asks to be hidden: an ask
       * from before the latest, as one a page that was out of sight sends
       * late, must not put away the window the operator just asked for.
       */
      let opening = 0;
      const cue = (what: QuickAccessCue) => {
        if (!window.isDestroyed())
          window.webContents.send(IPC_CHANNELS.quickAccessCue, encodeCue(what));
      };
      const opened = () => {
        opening += 1;
        cue({ _tag: "open", opening });
      };
      const stay = () => {
        cancel(leaving);
        leaving = null;
      };
      const hide = () => {
        stay();
        if (window.isDestroyed() || !window.isVisible()) return;
        const focused = window.isFocused();
        window.hide();
        // However it was put away, its page goes out with it, and comes in afresh next time.
        cue({ _tag: "leave" });
        // macOS leaves the app in front with no window: hiding the app gives
        // the keys back to the one the operator was in (**Assumed**).
        if (process.platform === "darwin" && focused && !main.isDestroyed() && !main.isVisible()) {
          app.hide();
        }
      };

      /** Puts the window on `workArea`, where it was left on that display or in its corner. */
      const place = (display: Electron.Display) => {
        const kept = placeOn(runSync(settings.get).quickAccess, String(display.id));
        placing = true;
        window.setBounds(quickAccessBounds(display.workArea, size, kept ?? defaultOffset(solid)));
        placing = false;
      };
      const open = () => {
        place(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
        window.show();
        window.focus();
        opened();
      };

      // Where the operator drags it is kept for the display it was dragged on,
      // once the drag has settled, and a window left partly off that display
      // comes back onto it.
      const settled = () => {
        settling = null;
        if (window.isDestroyed() || !window.isVisible()) return;
        const bounds = window.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const fitted = quickAccessBounds(
          display.workArea,
          size,
          cornerOffset(display.workArea, bounds),
        );
        if (fitted.x !== bounds.x || fitted.y !== bounds.y) {
          placing = true;
          window.setBounds(fitted);
          placing = false;
        }
        const offset = cornerOffset(display.workArea, fitted);
        const key = String(display.id);
        const kept = placeOn(runSync(settings.get).quickAccess, key);
        if (kept !== null && kept.right === offset.right && kept.bottom === offset.bottom) return;
        void runPromise(
          settings
            .update((current) => ({
              ...current,
              quickAccess: withPlace(current.quickAccess, key, offset),
            }))
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Saving where quick access stands failed", error),
              ),
            ),
        );
      };
      const moved = () => {
        if (placing || wayland || !window.isVisible()) return;
        cancel(settling);
        settling = after(SETTLED_AFTER, settled);
      };
      // Linux reports a drag as it goes (`move`); Windows and macOS also say when it ended.
      window.on("move", moved);
      window.on("moved", moved);
      // A display that changed under it: it goes back onto the one it is on.
      const displaysChanged = () => {
        if (window.isDestroyed() || !window.isVisible() || wayland) return;
        place(screen.getDisplayMatching(window.getBounds()));
      };
      screen.on("display-metrics-changed", displaysChanged);
      screen.on("display-removed", displaysChanged);

      // The system's own close (a key, a task switcher) puts it away as its button does.
      window.on("close", (event) => {
        if (gone) return;
        event.preventDefault();
        hide();
      });

      // Its page is loaded once the app's page is, and again whenever that one
      // is replaced, as after the server it runs on changed: what the page
      // held then was the other server's.
      const load = () => {
        if (window.isDestroyed()) return;
        available = false;
        hide();
        window.loadURL(url).catch((error: unknown) => {
          // Until it loads, the shortcut shows the main window.
          void runPromise(Effect.logWarning("Loading quick access failed", error));
        });
      };
      main.webContents.on("did-finish-load", load);
      // A page that went away, as when its process crashed or it was loaded
      // again from the menu, has nothing to show: a window left up over it
      // would be an unseen thing that takes the clicks meant for what is behind.
      const pageGone = () => {
        available = false;
        hide();
      };
      window.webContents.on("render-process-gone", pageGone);
      window.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) pageGone();
      });

      const repaint = () => {
        if (solid && !window.isDestroyed()) window.setBackgroundColor(cardColor());
      };
      nativeTheme.on("updated", repaint);

      // It goes with the app's window: once that one has closed, nothing keeps the app open.
      const mainClosed = () => {
        gone = true;
        if (!window.isDestroyed()) window.destroy();
      };
      main.on("closed", mainClosed);

      ipcMain.on(IPC_CHANNELS.quickAccess, (event, report: unknown) => {
        const decoded = decodeReport(report);
        if (!fromQuickAccess(event) || Option.isNone(decoded)) return;
        available = decoded.value.available;
      });
      ipcMain.on(IPC_CHANNELS.quickAccessHide, (event, request: unknown) => {
        const decoded = decodeHide(request);
        if (!fromQuickAccess(event) || Option.isNone(decoded)) return;
        if (decoded.value.opening === opening) hide();
      });
      ipcMain.on(IPC_CHANNELS.quickAccessOpenMain, (event, request: unknown) => {
        const decoded = decodeOpen(request);
        if (!fromQuickAccess(event) || Option.isNone(decoded)) return;
        hide();
        openInMain(decoded.value.target, decoded.value.pairing);
      });

      const toggle = () => {
        if (window.isDestroyed()) return showMain();
        const step = shortcutStep({
          available,
          visible: window.isVisible(),
          focused: window.isFocused(),
          leaving: leaving !== null,
        });
        switch (step) {
          case "show-main":
            return showMain();
          case "open":
            return open();
          case "return":
            stay();
            window.focus();
            return opened();
          case "leave":
            cue({ _tag: "leave" });
            leaving = after(LEAVE_WITHIN, hide);
        }
      };

      const unload = Effect.promise(() => {
        if (window.isDestroyed()) return Promise.resolve();
        available = false;
        hide();
        // A blank page in its place: the one that was there is gone when this resolves.
        return window.loadURL("about:blank").catch(() => undefined);
      });

      return {
        toggle,
        unload,
        release: () => {
          gone = true;
          stay();
          cancel(settling);
          ipcMain.removeAllListeners(IPC_CHANNELS.quickAccess);
          ipcMain.removeAllListeners(IPC_CHANNELS.quickAccessHide);
          ipcMain.removeAllListeners(IPC_CHANNELS.quickAccessOpenMain);
          nativeTheme.off("updated", repaint);
          screen.off("display-metrics-changed", displaysChanged);
          screen.off("display-removed", displaysChanged);
          if (!main.isDestroyed()) {
            main.off("closed", mainClosed);
            main.webContents.off("did-finish-load", load);
          }
          if (!window.isDestroyed()) window.destroy();
        },
      };
    }),
    ({ release }) => Effect.sync(release),
  );

  return { toggle, unload } satisfies QuickAccess;
});
