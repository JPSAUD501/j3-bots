// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Where the app runs from, read once as it starts, and a detached process started as it quits, after its runtime is gone.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { app } from "electron";
import { appOrigin, schemeOf } from "./identity.ts";

// Restarting the app: after a keyring is unlocked, and into an update.

/**
 * The AppImage this process runs from, or `null` when it runs from anything
 * else. An AppImage's runtime mounts it at `APPDIR` and names its file in
 * `APPIMAGE`, and every process the app starts inherits both, a deb's
 * included when started from one; so only a process whose own executable
 * lies inside `APPDIR` runs from the AppImage.
 */
export const runningAppImage: string | null = (() => {
  const appImage = process.env["APPIMAGE"];
  const appDir = process.env["APPDIR"];
  if (process.platform !== "linux" || appImage === undefined || appDir === undefined) return null;
  if (!NodePath.isAbsolute(appImage) || !NodePath.isAbsolute(appDir)) return null;
  const inside = NodePath.relative(appDir, process.execPath);
  if (inside === "" || inside.startsWith("..") || NodePath.isAbsolute(inside)) return null;
  // A runtime that mounts the AppImage names the folder `.mount_*`. Any other
  // folder is one it unpacked, as `--appimage-extract-and-run` does where FUSE
  // is missing: whatever this process starts from an AppImage, a restart or
  // an update's first run, must unpack it too, which the variable asks.
  if (!NodePath.basename(appDir).startsWith(".mount_")) {
    process.env["APPIMAGE_EXTRACT_AND_RUN"] = "1";
  }
  return appImage;
})();

/**
 * What starts this app anew from outside it, as a link or the system's sign-in
 * does: the AppImage it runs from, whose launcher adds what it needs, or the
 * executable it runs as, which is the deb's or the installed app's; in
 * development, Electron with the app's folder, without Chromium's sandbox
 * when this run has none (`scripts/launch.ts`).
 */
export const launchCommand = (): ReadonlyArray<string> => {
  if (runningAppImage !== null) return [runningAppImage];
  if (app.isPackaged) return [process.execPath];
  const unsandboxed = app.commandLine.hasSwitch("no-sandbox") ? ["--no-sandbox"] : [];
  return [process.execPath, app.getAppPath(), ...unsandboxed];
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
 * The arguments the app was started with, such as `--no-sandbox`, without a
 * link to the app it was started to follow (`appLinks.ts`): a restart opens
 * nothing by itself.
 */
const restartArgs = (): Array<string> => {
  const scheme = schemeOf(appOrigin(app.isPackaged));
  return process.argv.slice(1).filter((arg) => !arg.toLowerCase().startsWith(`${scheme}:`));
};

/**
 * Starts the app again once this process has exited, and quits. Quitting
 * closes the window as the operator would, so its place is saved and
 * IndexedDB is flushed.
 *
 * An AppImage starts `appImage`: by default the one it runs from, and after
 * an update the file the update was installed to, which electron-updater
 * names after the release when the operator's file had a version in its
 * name. Electron's relaunch will not do there: its relauncher runs from the
 * AppImage's mount, which goes as this process exits, and nothing starts.
 * Nor will starting it at once: the new process holds the old runtime's
 * descriptors, so that runtime and its mount never exit (as T3 Code found),
 * and races this one for the profile. A detached Bash, which the AppImage's
 * own launcher needs, closes what it inherited and waits for this process to
 * exit, with `-p` so that no `BASH_ENV` runs first. It is given the
 * arguments this process was, and an AppImage that runs unpacked starts
 * unpacked again. Anything else is restarted by Electron.
 */
export const restartApp = (appImage: string | null = runningAppImage): void => {
  if (appImage === null) app.relaunch({ args: restartArgs() });
  else {
    NodeChildProcess.spawn(
      "bash",
      [
        "-p",
        "-c",
        START_ONCE_GONE,
        "j3-bots-restart",
        String(process.pid),
        appImage,
        ...restartArgs(),
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
  }
  app.quit();
};
