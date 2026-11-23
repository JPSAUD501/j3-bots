// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  IPC_CHANNELS,
  StartWithSystemRequest,
  type StartWithSystemChange,
} from "@j3-bots/desktop-bridge";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { AutostartNotChanged, removeEntry, writeEntry } from "./autostartFile.ts";
import { renderAutostartEntry } from "./desktopEntry.ts";
import { appOrigin, schemeOf } from "./identity.ts";
import { launchCommand } from "./restart.ts";
import { DesktopSettings } from "./settings.ts";

// Starting the app with the system, as the operator signs in: hidden in the
// tray, so the bots this computer runs are back without a window in the way.
// Windows and macOS keep a login item for the app (`setLoginItemSettings`);
// Linux, where Electron has none, starts what the user's autostart folder
// lists (the XDG Autostart Specification).

/** The argument the system's start gives the app: it opens in the tray only. */
const HIDDEN_ARG = "--hidden";

/** Whether a launch with `argv` is the system's, as the operator signed in. */
export const startsHidden = (argv: ReadonlyArray<string>): boolean => argv.includes(HIDDEN_ARG);

/**
 * Whether this process is the system's launch, as the operator signed in:
 * started with `HIDDEN_ARG`, or on macOS, whose login items take no
 * arguments, opened as a login item. Asked once the app is ready.
 */
export const launchedHidden = (): boolean =>
  startsHidden(process.argv) ||
  (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);

/**
 * The app's entry in the user's autostart folder: one for a packaged build
 * and another for a development one, as their links have (`linkHandler.ts`).
 */
const linuxEntryFile = Effect.fn("Autostart.linuxEntryFile")(function* () {
  const path = yield* Path.Path;
  const configHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const folder = Option.getOrElse(configHome, () => path.join(app.getPath("home"), ".config"));
  return path.join(folder, "autostart", `${schemeOf(appOrigin(app.isPackaged))}.desktop`);
});

/** Makes the system start the app as the operator signs in, or stop doing so. */
const apply = Effect.fn("Autostart.apply")(function* (on: boolean) {
  const command = launchCommand();
  if (process.platform === "linux") {
    const file = yield* linuxEntryFile();
    if (!on) return yield* removeEntry(file);
    const entry = renderAutostartEntry({
      name: app.isPackaged ? "J3 Bots" : "J3 Bots Development",
      command: [...command, HIDDEN_ARG],
    });
    return yield* writeEntry(file, entry);
  }
  // Windows matches the login item by its executable and arguments, so both
  // are given to turn it off as well; macOS takes neither, and says the app
  // was opened at login instead (`startsHidden`).
  const [executable = process.execPath, ...args] = command;
  yield* Effect.try({
    try: () =>
      app.setLoginItemSettings({
        openAtLogin: on,
        path: executable,
        args: [...args, HIDDEN_ARG],
      }),
    catch: (cause) => new AutostartNotChanged({ cause }),
  });
});

const decodeRequest = Schema.decodeUnknownOption(StartWithSystemRequest);

/**
 * Keeps the system's start of the app as the settings say, and lets the page
 * change it. It holds only while the bots live on this computer. As the app
 * starts, an entry that is on is written again, so it names the app where it
 * runs now, as after an AppImage was moved, and removed when the bots live
 * elsewhere now, as when leaving this computer could not turn it off.
 */
export const serve = Effect.fn("desktop.autostart")(function* (
  fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
) {
  const settings = yield* DesktopSettings;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  const { startWithSystem, mode } = yield* settings.get;
  if (startWithSystem) {
    yield* apply(mode === "local").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Renewing the app's start with the system failed", error),
      ),
    );
  }

  const change = Effect.fn("desktop.setStartWithSystem")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Effect.fn.Return<StartWithSystemChange, never, FileSystem.FileSystem | Path.Path> {
    const was = (yield* settings.get).startWithSystem;
    const decoded = decodeRequest(request);
    if (!fromApp(event) || Option.isNone(decoded)) return { outcome: "not-saved", on: was };
    const { on } = decoded.value;
    if (on === was) return { outcome: "changed", on };
    const applied = yield* apply(on).pipe(Effect.result);
    if (applied._tag === "Failure") {
      yield* Effect.logWarning("Changing the app's start with the system failed", applied.failure);
      return { outcome: "not-saved", on: was };
    }
    const saved = yield* settings
      .update((current) => ({ ...current, startWithSystem: on }))
      .pipe(Effect.result);
    if (saved._tag === "Success") return { outcome: "changed", on };
    // Not kept: the system goes back to what the settings still say.
    yield* Effect.logWarning("Saving the app's start with the system failed", saved.failure);
    yield* apply(was).pipe(Effect.ignore);
    return { outcome: "not-saved", on: was };
  });

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      ipcMain.handle(IPC_CHANNELS.setStartWithSystem, (event, request: unknown) =>
        runPromise(change(event, request)),
      ),
    ),
    () => Effect.sync(() => ipcMain.removeHandler(IPC_CHANNELS.setStartWithSystem)),
  );
});
