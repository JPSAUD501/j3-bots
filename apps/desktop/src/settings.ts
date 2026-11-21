// SPDX-License-Identifier: AGPL-3.0-or-later
import { Accelerator, ServerOrigin } from "@j3-bots/desktop-bridge";
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
 * What the app keeps between launches, besides what the page keeps in its own
 * storage: the server the operator named, the window's place and the global
 * shortcut the operator chose (`null` for the default). None is a secret.
 */
export const Settings = Schema.Struct({
  server: Schema.NullOr(ServerOrigin),
  window: Schema.NullOr(WindowState),
  shortcut: Schema.NullOr(Accelerator),
});
export type Settings = typeof Settings.Type;

const EMPTY: Settings = { server: null, window: null, shortcut: null };

const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeServer = Schema.decodeUnknownOption(ServerOrigin);
const decodeWindow = Schema.decodeUnknownOption(WindowState);
const decodeShortcut = Schema.decodeUnknownOption(Accelerator);
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(Settings));

/**
 * The settings `text` holds, each entry read on its own: an entry that cannot
 * be read is dropped and the others kept. A server is kept only if the server
 * address screen would accept it now, so plain HTTP to a public host never
 * comes back from a file. `dropped` names the entries that were there and
 * were not kept.
 */
export const decodeSettings = (
  text: string,
): { readonly settings: Settings; readonly dropped: ReadonlyArray<keyof Settings> } => {
  const stored = decodeStored(text);
  if (Option.isNone(stored)) return { settings: EMPTY, dropped: [] };
  const { server, window, shortcut } = stored.value;
  const keptServer = Option.flatMap(decodeServer(server), (origin) => {
    const checked = parseServerAddress(origin);
    return Result.isSuccess(checked) && checked.success === origin
      ? Option.some(origin)
      : Option.none();
  });
  const keptWindow = decodeWindow(window);
  const keptShortcut = decodeShortcut(shortcut);
  const dropped: Array<keyof Settings> = [];
  if (server !== undefined && server !== null && Option.isNone(keptServer)) dropped.push("server");
  if (window !== undefined && window !== null && Option.isNone(keptWindow)) dropped.push("window");
  if (shortcut !== undefined && shortcut !== null && Option.isNone(keptShortcut)) {
    dropped.push("shortcut");
  }
  return {
    settings: {
      server: Option.getOrNull(keptServer),
      window: Option.getOrNull(keptWindow),
      shortcut: Option.getOrNull(keptShortcut),
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
