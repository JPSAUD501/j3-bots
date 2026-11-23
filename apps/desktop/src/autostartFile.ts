// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// The file that starts the app with the system on Linux: its entry in the
// user's autostart folder (`autostart.ts`).

/** The system's start of the app could not be changed; it is as it was. */
export class AutostartNotChanged extends Schema.TaggedError<AutostartNotChanged>()(
  "AutostartNotChanged",
  { cause: Schema.Defect() },
) {}

/**
 * Writes `entry` to `file`, through a temporary file renamed over it, unless
 * the file already holds it.
 */
export const writeEntry = Effect.fn("Autostart.writeEntry")(
  function* (file: string, entry: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const written = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.getOrNull(written) === entry) return;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    yield* fs.writeFileString(temporary, entry);
    yield* fs.rename(temporary, file);
  },
  Effect.mapError((cause) => new AutostartNotChanged({ cause })),
);

/** Removes `file`, which may already be gone. */
export const removeEntry = Effect.fn("Autostart.removeEntry")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file, { force: true });
  },
  Effect.mapError((cause) => new AutostartNotChanged({ cause })),
);
