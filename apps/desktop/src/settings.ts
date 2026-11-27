// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, UpdateChannel } from "@j3-bots/contracts";
import {
  Accelerator,
  Appearance,
  DesktopMode,
  MovedAway,
  ServerOrigin,
} from "@j3-bots/desktop-bridge";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parseServerAddress } from "./serverAddress.ts";

/** The window's place on screen when it last closed. */
export const WindowState = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maximized: Schema.Boolean,
});
export type WindowState = typeof WindowState.Type;

/**
 * Where quick access was last put on a display, by the display's id: how far
 * its right and bottom edges stand from that display's work area's
 * (`quickAccessPlace.ts`).
 */
const QuickAccessPlace = Schema.Struct({
  display: Schema.String,
  right: Schema.Int,
  bottom: Schema.Int,
});

/**
 * The device this computer was last signed in as on the server it runs: its
 * id, which the next sign-in replaces (revokes), never its token, which only
 * the page keeps; and whether it is `current`, the device of the operator's
 * present choice of this computer. Only a device that is not current is
 * replaced without the operator asking (`LocalDeviceRequest`).
 */
const LocalDevice = Schema.Struct({ id: DeviceId, current: Schema.Boolean });

/**
 * What the app keeps between launches, besides what the page keeps in its own
 * storage: where the bots live (`mode`, `null` until the operator chose), the
 * server the page runs on (the one the operator named, or the one on this
 * computer), the device this computer was signed in as on its own server,
 * the window's place, the global shortcut the operator chose (`null` for the
 * default), the appearance the page last reported, which the window takes
 * before the page paints, whether the app starts with the system, off
 * until the operator turns it on, whether phones on the network may reach
 * the server on this computer (`phoneAccess`), off until the operator turns
 * it on, the releases the app updates to (`updateChannel`), stable ones
 * until the operator chooses nightly builds too, and whether a verified
 * version installs by itself (`automaticUpdates`), at launch or as the app
 * quits, on until the operator turns it off, and the export the bots on this
 * computer moved away with (`moved`), while their data is still here and
 * their server stays stopped, and where quick access was last put on each
 * display it was dragged on, the latest last (`quickAccess`), and what
 * quick access reads of the window in front as it opens: its title, on
 * until the operator turns it off (`windowTitle`), and a picture of it for
 * every message, off until the operator turns it on (`windowPicture`). None
 * is a secret.
 */
export const Settings = Schema.Struct({
  mode: Schema.NullOr(DesktopMode),
  server: Schema.NullOr(ServerOrigin),
  localDevice: Schema.NullOr(LocalDevice),
  window: Schema.NullOr(WindowState),
  shortcut: Schema.NullOr(Accelerator),
  appearance: Appearance,
  startWithSystem: Schema.Boolean,
  phoneAccess: Schema.Boolean,
  updateChannel: UpdateChannel,
  automaticUpdates: Schema.Boolean,
  moved: Schema.NullOr(MovedAway),
  quickAccess: Schema.Array(QuickAccessPlace),
  windowTitle: Schema.Boolean,
  windowPicture: Schema.Boolean,
});
export type Settings = typeof Settings.Type;

const EMPTY: Settings = {
  mode: null,
  server: null,
  localDevice: null,
  window: null,
  shortcut: null,
  appearance: "system",
  startWithSystem: false,
  phoneAccess: false,
  updateChannel: "stable",
  automaticUpdates: true,
  moved: null,
  quickAccess: [],
  windowTitle: true,
  windowPicture: false,
};

const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeMode = Schema.decodeUnknownOption(DesktopMode);
const decodeServer = Schema.decodeUnknownOption(ServerOrigin);
const decodeLocalDevice = Schema.decodeUnknownOption(LocalDevice);
const decodeWindow = Schema.decodeUnknownOption(WindowState);
const decodeShortcut = Schema.decodeUnknownOption(Accelerator);
const decodeAppearance = Schema.decodeUnknownOption(Appearance);
const decodeFlag = Schema.decodeUnknownOption(Schema.Boolean);
const decodeChannel = Schema.decodeUnknownOption(UpdateChannel);
const decodeMoved = Schema.decodeUnknownOption(MovedAway);
const decodeQuickAccess = Schema.decodeUnknownOption(Schema.Array(QuickAccessPlace));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(Settings));

/**
 * The settings `text` holds, each entry read on its own: an entry that cannot
 * be read is dropped and the others kept. A server is kept only if the server
 * address screen would accept it now, so plain HTTP to a public host never
 * comes back from a file. `dropped` names the entries that were there and
 * were not kept. A file from before the app could run the server keeps no
 * mode: one that names a server is `remote`.
 */
export const decodeSettings = (
  text: string,
): { readonly settings: Settings; readonly dropped: ReadonlyArray<keyof Settings> } => {
  const stored = decodeStored(text);
  if (Option.isNone(stored)) return { settings: EMPTY, dropped: [] };
  const {
    mode,
    server,
    localDevice,
    window,
    shortcut,
    appearance,
    startWithSystem,
    phoneAccess,
    updateChannel,
    automaticUpdates,
    moved,
    quickAccess,
    windowTitle,
    windowPicture,
  } = stored.value;
  const keptServer = Option.flatMap(decodeServer(server), (origin) => {
    const checked = parseServerAddress(origin);
    return Result.isSuccess(checked) && checked.success === origin
      ? Option.some(origin)
      : Option.none();
  });
  const keptMode = decodeMode(mode);
  const keptLocalDevice = decodeLocalDevice(localDevice);
  const keptWindow = decodeWindow(window);
  const keptShortcut = decodeShortcut(shortcut);
  const keptAppearance = decodeAppearance(appearance);
  const keptStartWithSystem = decodeFlag(startWithSystem);
  const keptPhoneAccess = decodeFlag(phoneAccess);
  const keptChannel = decodeChannel(updateChannel);
  const keptAutomaticUpdates = decodeFlag(automaticUpdates);
  const keptMoved = decodeMoved(moved);
  const keptQuickAccess = decodeQuickAccess(quickAccess);
  const keptWindowTitle = decodeFlag(windowTitle);
  const keptWindowPicture = decodeFlag(windowPicture);
  const dropped: Array<keyof Settings> = [];
  if (mode !== undefined && mode !== null && Option.isNone(keptMode)) dropped.push("mode");
  if (server !== undefined && server !== null && Option.isNone(keptServer)) dropped.push("server");
  if (localDevice !== undefined && localDevice !== null && Option.isNone(keptLocalDevice)) {
    dropped.push("localDevice");
  }
  if (window !== undefined && window !== null && Option.isNone(keptWindow)) dropped.push("window");
  if (shortcut !== undefined && shortcut !== null && Option.isNone(keptShortcut)) {
    dropped.push("shortcut");
  }
  if (appearance !== undefined && Option.isNone(keptAppearance)) dropped.push("appearance");
  if (startWithSystem !== undefined && Option.isNone(keptStartWithSystem)) {
    dropped.push("startWithSystem");
  }
  if (phoneAccess !== undefined && Option.isNone(keptPhoneAccess)) dropped.push("phoneAccess");
  if (updateChannel !== undefined && Option.isNone(keptChannel)) dropped.push("updateChannel");
  if (automaticUpdates !== undefined && Option.isNone(keptAutomaticUpdates)) {
    dropped.push("automaticUpdates");
  }
  if (moved !== undefined && moved !== null && Option.isNone(keptMoved)) dropped.push("moved");
  if (quickAccess !== undefined && Option.isNone(keptQuickAccess)) dropped.push("quickAccess");
  if (windowTitle !== undefined && Option.isNone(keptWindowTitle)) dropped.push("windowTitle");
  if (windowPicture !== undefined && Option.isNone(keptWindowPicture)) {
    dropped.push("windowPicture");
  }
  return {
    settings: {
      mode: Option.getOrElse(keptMode, () =>
        mode === undefined && Option.isSome(keptServer) ? "remote" : null,
      ),
      server: Option.getOrNull(keptServer),
      localDevice: Option.getOrNull(keptLocalDevice),
      window: Option.getOrNull(keptWindow),
      shortcut: Option.getOrNull(keptShortcut),
      appearance: Option.getOrElse(keptAppearance, () => EMPTY.appearance),
      startWithSystem: Option.getOrElse(keptStartWithSystem, () => EMPTY.startWithSystem),
      phoneAccess: Option.getOrElse(keptPhoneAccess, () => EMPTY.phoneAccess),
      updateChannel: Option.getOrElse(keptChannel, () => EMPTY.updateChannel),
      automaticUpdates: Option.getOrElse(keptAutomaticUpdates, () => EMPTY.automaticUpdates),
      moved: Option.getOrNull(keptMoved),
      quickAccess: Option.getOrElse(keptQuickAccess, () => EMPTY.quickAccess),
      windowTitle: Option.getOrElse(keptWindowTitle, () => EMPTY.windowTitle),
      windowPicture: Option.getOrElse(keptWindowPicture, () => EMPTY.windowPicture),
    },
    dropped,
  };
};

/** The settings file could not be written; the settings are as they were. */
export class SettingsNotSaved extends Schema.TaggedError<SettingsNotSaved>()("SettingsNotSaved", {
  cause: Schema.Defect(),
}) {}

export class DesktopSettings extends Context.Service<
  DesktopSettings,
  {
    readonly get: Effect.Effect<Settings>;
    /**
     * Applies `change` and writes the result. The change takes effect only
     * once written: a write that fails leaves the settings as they were.
     */
    readonly update: (
      change: (settings: Settings) => Settings,
    ) => Effect.Effect<Settings, SettingsNotSaved>;
  }
>()("@j3-bots/desktop/settings/DesktopSettings") {}

/**
 * The settings in `file`. A file that is missing starts the app as on its
 * first launch; an entry in it that cannot be read is dropped, with a
 * warning. Each write replaces the file whole, through a temporary file
 * renamed over it.
 */
export const layer = (file: string) =>
  Layer.effect(
    DesktopSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const text = yield* fs.readFileString(file).pipe(Effect.option);
      const loaded = Option.match(text, {
        onNone: () => ({ settings: EMPTY, dropped: [] }),
        onSome: decodeSettings,
      });
      if (loaded.dropped.length > 0) {
        yield* Effect.logWarning("Dropped desktop settings that could not be read", loaded.dropped);
      }
      const current = yield* Ref.make(loaded.settings);
      const writing = yield* Semaphore.make(1);
      const write = Effect.fn("DesktopSettings.write")(
        function* (settings: Settings) {
          const encoded = yield* encodeFile(settings);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          const temporary = `${file}.tmp`;
          yield* fs.writeFileString(temporary, encoded);
          yield* fs.rename(temporary, file);
        },
        Effect.mapError((cause) => new SettingsNotSaved({ cause })),
      );
      const update = Effect.fn("DesktopSettings.update")(
        (change: (settings: Settings) => Settings) =>
          writing.withPermits(1)(
            Effect.gen(function* () {
              const next = change(yield* Ref.get(current));
              yield* write(next);
              yield* Ref.set(current, next);
              return next;
            }),
          ),
      );
      return DesktopSettings.of({ get: Ref.get(current), update });
    }),
  );
