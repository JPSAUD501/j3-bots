// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- One synchronous existence check of the development feed, before the updater is configured.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { UpdateChannel } from "@j3-bots/contracts";
import {
  IPC_CHANNELS,
  releaseFile,
  SavingReport,
  UpdateChannelRequest,
  UpdateStatus,
} from "@j3-bots/desktop-bridge";
import { sha256File, signatureCheck } from "@j3-bots/release/node";
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
import { AppImageUpdater, autoUpdater, type UpdateDownloadedEvent } from "electron-updater";
import { type DownloadCheckPorts, verifyDownload } from "./downloadCheck.ts";
import { electronFetch } from "./electronFetch.ts";
import { restartApp, runningAppImage } from "./restart.ts";
import { DesktopSettings } from "./settings.ts";
import {
  type Action,
  initial,
  mayCheck,
  mayChooseChannel,
  step,
  type UpdateEvent,
  type UpdateMode,
  type Updates,
} from "./updates.ts";

// Updating the app from its release feed: electron-updater checks at launch
// and every six hours and downloads in the background; each download is
// checked against the release's signed checksums (`downloadCheck.ts`), and
// the operator restarts into the new version from the page (`updates.ts`
// decides when).

const CHECK_EVERY = "6 hours";

/** The feed a development build reads, beside its package.json, as electron-updater names it. */
const DEV_FEED = "dev-app-update.yml";

const encodeStatus = Schema.encodeSync(UpdateStatus);
const decodeSaving = Schema.decodeUnknownOption(SavingReport);
const decodeChannel = Schema.decodeUnknownOption(UpdateChannelRequest);

/**
 * What checking a download reads: the release's files from the repository
 * the feed is (`releaseFile`), over the system's network stack, and the
 * release key. A file the release does not have answers 404.
 */
const downloadCheck: DownloadCheckPorts = {
  releaseFile: async (version, name) => {
    const response = await electronFetch(releaseFile(version, name));
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`The release answered ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  },
  sha256File,
  check: signatureCheck(),
  platform: process.platform,
};

/**
 * Points electron-updater at the releases of `channel`: the stable ones, read
 * from the release GitHub marks as the latest and its `latest*.yml`, or the
 * nightly builds too, the newest prerelease whose version is a nightly one
 * and its `nightly*.yml` (read in electron-updater 6.8.9,
 * `providers/GitHubProvider.js`). Setting a channel also lets electron-updater
 * install an older version (`AppUpdater.js`, `set channel`); the app never
 * does, so a nightly build waits on the stable channel until a stable release
 * is newer than it.
 */
const follow = (channel: UpdateChannel) => {
  autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade = false;
};

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
  const settings = yield* DesktopSettings;
  const { updateChannel } = yield* settings.get;
  const check = yield* Effect.acquireRelease(
    Effect.sync(() => {
      let state: Updates = initial(updateMode(), updateChannel);
      follow(state.channel);
      // Where the build installs, downloaded in the background and installed
      // only when the operator asks, never as the app quits.
      autoUpdater.autoDownload = state.installs;
      autoUpdater.autoInstallOnAppQuit = false;
      // The AppImage an update was installed to, when not the one the app runs from.
      let installedTo: string | null = null;

      // The file electron-updater downloaded last, which a verdict is about.
      let downloadedFile: string | null = null;

      const status = () =>
        encodeStatus({ current: app.getVersion(), channel: state.channel, phase: state.phase });
      const dispatch = (event: UpdateEvent) => {
        const taken = step(state, event);
        const changed = taken.next.phase !== state.phase || taken.next.channel !== state.channel;
        state = taken.next;
        if (changed && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.updateChanged, status());
        }
        if (taken.action !== null) act(taken.action);
      };
      const act = (action: Action) => {
        switch (action._tag) {
          case "install":
            return install();
          case "verify":
            return verify(action.version);
          case "follow-channel":
            follow(state.channel);
            return check();
        }
      };
      /**
       * Checks the downloaded file against the signed checksums of the
       * release it belongs to. Anything short of a match, including checksums
       * that cannot be read, refuses it: the restart is never offered.
       */
      const verify = (version: string) => {
        const file = downloadedFile;
        const verdict =
          file === null
            ? Effect.succeed(false)
            : verifyDownload({ file, version }, downloadCheck).pipe(
                Effect.as(true),
                Effect.catch((refusal) =>
                  Effect.logWarning("The app's update did not match its release", refusal).pipe(
                    Effect.as(false),
                  ),
                ),
              );
        void runPromise(verdict).then((matched) =>
          dispatch({ _tag: "verified", version, matched }),
        );
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
        "update-downloaded": (info: UpdateDownloadedEvent) => {
          downloadedFile = info.downloadedFile;
          dispatch({ _tag: "downloaded", version: info.version });
        },
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
      /**
       * Keeps the operator's channel, then follows it. One that is not kept,
       * or that comes while a version is on its way, changes nothing; the
       * answer says which channel holds.
       */
      const choose = Effect.fn("desktop.chooseUpdateChannel")(function* (channel: UpdateChannel) {
        if (channel === state.channel || !mayChooseChannel(state)) return status();
        const saved = yield* settings
          .update((current) => ({ ...current, updateChannel: channel }))
          .pipe(Effect.result);
        if (saved._tag === "Failure") {
          yield* Effect.logWarning("Saving the app's update channel failed", saved.failure);
          return status();
        }
        dispatch({ _tag: "channel-chosen", channel });
        return status();
      });
      ipcMain.handle(IPC_CHANNELS.setUpdateChannel, (event, request: unknown) => {
        const decoded = decodeChannel(request);
        if (!fromApp(event)) return null;
        return Option.isSome(decoded) ? runPromise(choose(decoded.value.channel)) : status();
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
        ipcMain.removeHandler(IPC_CHANNELS.setUpdateChannel);
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
