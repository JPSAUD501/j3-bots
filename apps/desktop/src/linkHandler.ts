// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { app } from "electron";
import { renderLinkHandlerEntry } from "./desktopEntry.ts";
import { launchCommand, runningAppImage } from "./restart.ts";

// Makes this app the system's handler of its links (`<scheme>://…`), as it
// starts. On macOS and Windows Electron does it. On Linux the deb's own
// desktop entry declares the scheme, and goes with the package. An AppImage
// has no installed entry for Electron's own call to name, and its executable
// lies in a mount that goes as it exits; so it, like a development build,
// writes a desktop entry of its own and names it the default with `xdg-mime`,
// as T3 Code does (read at c6ca01b3, `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`).

/** Runs a command to its end; its exit code, or none when it could not start or took too long. */
const run = Effect.fn("LinkHandler.run")(
  function* (command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* handle.exitCode);
  },
  Effect.scoped,
  Effect.timeoutOption("5 seconds"),
  Effect.option,
  Effect.map(Option.flatten),
);

const registerOnLinux = Effect.fn("LinkHandler.registerOnLinux")(function* (scheme: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataHome = yield* Config.option(Config.NonEmptyString("XDG_DATA_HOME"));
  const applications = path.join(
    Option.getOrElse(dataHome, () => path.join(app.getPath("home"), ".local", "share")),
    "applications",
  );
  const entryName = `${scheme}-links.desktop`;
  const entry = renderLinkHandlerEntry({
    name: app.isPackaged ? "J3 Bots" : "J3 Bots Development",
    command: launchCommand(),
    scheme,
  });
  const entryPath = path.join(applications, entryName);
  const written = yield* fs.readFileString(entryPath).pipe(Effect.option);
  if (Option.getOrNull(written) !== entry) {
    yield* fs.makeDirectory(applications, { recursive: true });
    yield* fs.writeFileString(entryPath, entry);
  }
  // GIO checks a scheme's handler against this cache; without the tool the default is still set.
  const refreshed = yield* run("update-desktop-database", [applications]);
  if (Option.getOrNull(refreshed) !== 0) {
    yield* Effect.logWarning("Refreshing the desktop entries' cache failed", { applications });
  }
  const set = yield* run("xdg-mime", ["default", entryName, `x-scheme-handler/${scheme}`]);
  if (Option.getOrNull(set) !== 0) {
    yield* Effect.logWarning("Naming the app the handler of its links failed", { scheme });
  }
});

/**
 * Names this app the handler of `scheme`'s links. A failure is logged: links
 * then open nothing, and the app works as before.
 */
export const register = Effect.fn("LinkHandler.register")(function* (scheme: string) {
  if (process.platform === "linux") {
    // The deb's entry is the package's: removing it leaves nothing behind.
    if (app.isPackaged && runningAppImage === null) return;
    return yield* registerOnLinux(scheme).pipe(
      Effect.catch((error) => Effect.logWarning("Registering the app's links failed", error)),
    );
  }
  // A development build is Electron's own executable, started with the app's folder.
  const registered = app.isPackaged
    ? app.setAsDefaultProtocolClient(scheme)
    : app.setAsDefaultProtocolClient(scheme, process.execPath, [app.getAppPath()]);
  if (!registered) yield* Effect.logWarning("Registering the app's links failed", { scheme });
});
