// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- One synchronous existence check of the development feed, before the updater is configured, and a detached process started as the app quits, after its runtime is gone.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { IPC_CHANNELS, SavingReport, UpdateStatus } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  app,
  autoUpdater as nativeUpdater,
  type BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import { initial, mayCheck, step, type UpdateEvent, type Updates } from "./updates.ts";

// Updating the app from its release feed: electron-updater checks at launch
// and every six hours and downloads in the background; the operator restarts
// into the new version from the page (`updates.ts` decides when).

const CHECK_EVERY = "6 hours";

/** The feed a development build reads, beside its package.json, as electron-updater names it. */
const DEV_FEED = "dev-app-update.yml";

const encodeStatus = Schema.encodeSync(UpdateStatus);
const decodeSaving = Schema.decodeUnknownOption(SavingReport);

/**
 * Whether this build updates itself. A packaged build does where
 * electron-updater can replace it (an AppImage, a deb, an NSIS install). A
 * development build does only against a `dev-app-update.yml` of its own. On
 * macOS, Squirrel.Mac installs only a signed app, and builds are unsigned for
 * now, so a Mac build does not try.
 */
const updatable = (): boolean => {
  if (process.platform === "darwin") return false;
  if (!app.isPackaged) {
    if (!NodeFS.existsSync(NodePath.join(app.getAppPath(), DEV_FEED))) return false;
    autoUpdater.forceDevUpdateConfig = true;
  }
  return autoUpdater.isUpdaterActive();
};

/**
 * Closes every descriptor above standard error, waits until the process `$1`
 * is gone, then runs the rest of the arguments in its place.
 */
const START_ONCE_GONE = [
  'for fd in /proc/$$/fd/*; do n="${fd##*/}"; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done',
  'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done',
  "shift",
  'exec "$@"',
].join("\n");

/**
 * Starts the AppImage at `appImage` once this process has exited, detached
 * from it. Neither Electron's relaunch nor electron-updater's will do: the
 * first runs its relauncher from the old AppImage's mount, which goes as this
 * process exits, and the new version never starts; the second starts it at
 * once, holding the old AppImage runtime's descriptors, so that runtime and
 * its mount never exit (as T3 Code found), and racing this instance for the
 * profile. Bash, which the AppImage's own launcher needs, closes what it
 * inherited, with `-p` so that no `BASH_ENV` runs first.
 */
const startOnceGone = (appImage: string) => {
  NodeChildProcess.spawn(
    "bash",
    ["-p", "-c", START_ONCE_GONE, "j3-bots-update", String(process.pid), appImage],
    { detached: true, stdio: "ignore" },
  ).unref();
};

/**
 * Serves the update's status to `window`'s page and keeps it current, for as
 * long as the scope lasts. `fromApp` says whether an IPC message comes from
 * the app's own top frame; nothing else is heard.
 */
export const serve = Effect.fn("desktop.updates")(function* (
  window: BrowserWindow,
  fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
) {
  const check = yield* Effect.acquireRelease(
    Effect.sync(() => {
      // Downloaded in the background; installed only when the operator asks,
      // never as the app quits.
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      let state: Updates = initial(updatable());

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
       * Installs silently and starts the new version once this one has quit.
       * An AppImage is replaced in place by electron-updater and started by
       * `startOnceGone`. A failure arrives as an `error`.
       */
      const install = () => {
        const appImage = process.env["APPIMAGE"];
        try {
          if (appImage === undefined) {
            autoUpdater.quitAndInstall(true, true);
            return;
          }
          // Emitted only once the file is replaced, right before quitting.
          nativeUpdater.once("before-quit-for-update", () => startOnceGone(appImage));
          autoUpdater.quitAndInstall(true, false);
        } catch {
          dispatch({ _tag: "failed" });
        }
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
      } as const;
      autoUpdater.on("update-not-available", updater["update-not-available"]);
      autoUpdater.on("update-available", updater["update-available"]);
      autoUpdater.on("download-progress", updater["download-progress"]);
      autoUpdater.on("update-downloaded", updater["update-downloaded"]);
      autoUpdater.on("update-cancelled", updater["update-cancelled"]);
      autoUpdater.on("error", updater.error);

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
