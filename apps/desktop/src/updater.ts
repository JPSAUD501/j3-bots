// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- One synchronous existence check of the development feed, before the updater is configured.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { IPC_CHANNELS, SavingReport, UpdateStatus } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  app,
  type BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { AppImageUpdater, autoUpdater } from "electron-updater";
import { restartApp, runningAppImage } from "./restart.ts";
import {
  initial,
  mayCheck,
  step,
  type UpdateEvent,
  type UpdateMode,
  type Updates,
} from "./updates.ts";

// Updating the app from its release feed: electron-updater checks at launch
// and every six hours and downloads in the background; the operator restarts
// into the new version from the page (`updates.ts` decides when).

const CHECK_EVERY = "6 hours";

/** The feed a development build reads, beside its package.json, as electron-updater names it. */
const DEV_FEED = "dev-app-update.yml";

const encodeStatus = Schema.encodeSync(UpdateStatus);
const decodeSaving = Schema.decodeUnknownOption(SavingReport);

/**
 * How this build updates. An NSIS install and an AppImage install a newer
 * version themselves: each replaces files the operator's user owns. Any other
 * packaged build only says one is out. A deb would need root to install it,
 * and the app never asks for that; Squirrel.Mac installs only a signed app,
 * and builds are unsigned for now. A development build checks only against a
 * `dev-app-update.yml` of its own.
 */
const updateMode = (): UpdateMode => {
  if (!app.isPackaged) {
    if (!NodeFS.existsSync(NodePath.join(app.getAppPath(), DEV_FEED))) return "off";
    autoUpdater.forceDevUpdateConfig = true;
  }
  if (!autoUpdater.isUpdaterActive()) return "off";
  const installs =
    process.platform === "win32" ||
    (runningAppImage !== null && autoUpdater instanceof AppImageUpdater);
  return installs ? "install" : "notify";
};

/** What installing an update does to the server this computer runs, if it runs one. */
export interface InstallSteps {
  /** Stops it before the update replaces the app, whose runtime it may run. */
  readonly beforeInstall: Effect.Effect<void>;
  /** Starts it again when the install failed and the app stays. */
  readonly installFailed: Effect.Effect<void>;
}

/**
 * Serves the update's status to `window`'s page and keeps it current, for as
 * long as the scope lasts. `fromApp` says whether an IPC message comes from
 * the app's own top frame; nothing else is heard.
 */
export const serve = Effect.fn("desktop.updates")(function* (
  window: BrowserWindow,
  fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  steps: InstallSteps,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const check = yield* Effect.acquireRelease(
    Effect.sync(() => {
      let state: Updates = initial(updateMode());
      // Where the build installs, downloaded in the background and installed
      // only when the operator asks, never as the app quits.
      autoUpdater.autoDownload = state.installs;
      autoUpdater.autoInstallOnAppQuit = false;
      // The AppImage an update was installed to, when not the one the app runs from.
      let installedTo: string | null = null;

      const status = () => encodeStatus({ current: app.getVersion(), phase: state.phase });
      const dispatch = (event: UpdateEvent) => {
        const taken = step(state, event);
        const changed = taken.next.phase !== state.phase;
        state = taken.next;
        if (changed && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.updateChanged, status());
        }
        if (taken.install) install();
      };
      /**
       * Installs silently and starts the new version once this one has quit:
       * the NSIS installer starts it on Windows, and `restartApp` starts an
       * AppImage, which electron-updater replaced. The server this computer
       * runs is stopped first, as T3 Code's desktop stops its own (read at
       * db51b671, `apps/desktop/src/updates/DesktopUpdates.ts`). A failure is
       * dispatched as an `error` before `quitAndInstall` returns, and the app
       * stays, with the server started again.
       */
      const install = () => {
        void runPromise(steps.beforeInstall).then(() => {
          if (runningAppImage === null) autoUpdater.quitAndInstall(true, true);
          else {
            autoUpdater.quitAndInstall(true, false);
            if (state.phase._tag === "installing") restartApp(installedTo ?? runningAppImage);
          }
          if (state.phase._tag === "failed") void runPromise(steps.installFailed);
        });
      };
      const check = () => {
        if (!mayCheck(state)) return;
        dispatch({ _tag: "check-started" });
        // The check, then the download it starts. A failure of either also
        // arrives as an `error` event.
        autoUpdater
          .checkForUpdates()
          .then((result) => result?.downloadPromise)
          .catch(() => dispatch({ _tag: "failed" }));
      };

      const updater = {
        "update-not-available": () => dispatch({ _tag: "not-available" }),
        "update-available": (info: { readonly version: string }) =>
          dispatch({ _tag: "available", version: info.version }),
        "download-progress": (info: { readonly percent: number }) =>
          dispatch({ _tag: "progress", percent: info.percent }),
        "update-downloaded": (info: { readonly version: string }) =>
          dispatch({ _tag: "downloaded", version: info.version }),
        "update-cancelled": () => dispatch({ _tag: "failed" }),
        error: () => dispatch({ _tag: "failed" }),
        "appimage-filename-updated": (path: string) => {
          installedTo = path;
        },
      } as const;
      autoUpdater.on("update-not-available", updater["update-not-available"]);
      autoUpdater.on("update-available", updater["update-available"]);
      autoUpdater.on("download-progress", updater["download-progress"]);
      autoUpdater.on("update-downloaded", updater["update-downloaded"]);
      autoUpdater.on("update-cancelled", updater["update-cancelled"]);
      autoUpdater.on("error", updater.error);
      autoUpdater.on("appimage-filename-updated", updater["appimage-filename-updated"]);

      ipcMain.handle(IPC_CHANNELS.update, (event) => (fromApp(event) ? status() : null));
      ipcMain.on(IPC_CHANNELS.checkForUpdates, (event) => {
        if (fromApp(event)) check();
      });
      ipcMain.on(IPC_CHANNELS.restartToUpdate, (event) => {
        if (fromApp(event)) dispatch({ _tag: "restart-requested" });
      });
      ipcMain.on(IPC_CHANNELS.saving, (event, report: unknown) => {
        const decoded = decodeSaving(report);
        if (fromApp(event) && Option.isSome(decoded)) {
          dispatch({ _tag: "saving", saving: decoded.value.saving });
        }
      });
      // A page that loads again, or whose renderer went, has no save under way.
      const pageGone = () => dispatch({ _tag: "saving", saving: false });
      window.webContents.on("did-navigate", pageGone);
      window.webContents.on("render-process-gone", pageGone);

      return { updater, pageGone, check };
    }),
    ({ updater, pageGone }) =>
      Effect.sync(() => {
        autoUpdater.off("update-not-available", updater["update-not-available"]);
        autoUpdater.off("update-available", updater["update-available"]);
        autoUpdater.off("download-progress", updater["download-progress"]);
        autoUpdater.off("update-downloaded", updater["update-downloaded"]);
        autoUpdater.off("update-cancelled", updater["update-cancelled"]);
        autoUpdater.off("error", updater.error);
        autoUpdater.off("appimage-filename-updated", updater["appimage-filename-updated"]);
        ipcMain.removeHandler(IPC_CHANNELS.update);
        ipcMain.removeAllListeners(IPC_CHANNELS.checkForUpdates);
        ipcMain.removeAllListeners(IPC_CHANNELS.restartToUpdate);
        ipcMain.removeAllListeners(IPC_CHANNELS.saving);
        if (!window.isDestroyed()) {
          window.webContents.off("did-navigate", pageGone);
          window.webContents.off("render-process-gone", pageGone);
        }
      }),
  ).pipe(Effect.map(({ check }) => check));
  // At launch, then every six hours, for as long as the app runs.
  yield* Effect.forkScoped(Effect.sync(check).pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY))));
});
