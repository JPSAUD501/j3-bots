// SPDX-License-Identifier: AGPL-3.0-or-later
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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
 * storage: the server the operator named and the window's place. Neither is
 * a secret.
 */
export const Settings = Schema.Struct({
  server: Schema.NullOr(ServerOrigin),
  window: Schema.NullOr(WindowState),
});
export type Settings = typeof Settings.Type;

const EMPTY: Settings = { server: null, window: null };

const SettingsFile = Schema.fromJsonString(Settings);
const decodeFile = Schema.decodeUnknownOption(SettingsFile);
const encodeFile = Schema.encodeEffect(SettingsFile);

export class DesktopSettings extends Context.Service<
  DesktopSettings,
  {
    readonly get: Effect.Effect<Settings>;
    /** Applies `change` and writes the result; a write that fails is logged and the change kept in memory. */
    readonly update: (change: (settings: Settings) => Settings) => Effect.Effect<Settings>;
  }
>()("@j3-bots/desktop/settings/DesktopSettings") {}

/**
 * The settings in `file`. A file that is missing or cannot be read as
 * settings starts the app as on its first launch. Each write replaces the
 * file whole, through a temporary file renamed over it.
 */
export const layer = (file: string) =>
  Layer.effect(
    DesktopSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stored = yield* fs
        .readFileString(file)
        .pipe(Effect.map(decodeFile), Effect.orElseSucceed(Option.none));
      const current = yield* Ref.make(Option.getOrElse(stored, () => EMPTY));
      const writing = yield* Semaphore.make(1);
      const write = Effect.fn("DesktopSettings.write")(
        function* (settings: Settings) {
          const text = yield* encodeFile(settings);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          const temporary = `${file}.tmp`;
          yield* fs.writeFileString(temporary, text);
          yield* fs.rename(temporary, file);
        },
        Effect.catch((error) => Effect.logWarning("Saving the desktop settings failed", error)),
      );
      const update = Effect.fn("DesktopSettings.update")(
        (change: (settings: Settings) => Settings) =>
          writing.withPermits(1)(Ref.updateAndGet(current, change).pipe(Effect.tap(write))),
      );
      return DesktopSettings.of({ get: Ref.get(current), update });
    }),
  );
