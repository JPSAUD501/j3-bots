// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";

// A file the server writes is never seen half-written: its contents go to a
// new file beside it first, which then takes its name. A full disk or a crash
// leaves at most that temporary file, never a partial one at the name.

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

/**
 * Writes `data` to a new file (mode `mode`) of a random name in `file`'s
 * folder, one that must not exist yet, so a link planted in its place is
 * never followed; then `place`s it at `file`. The temporary name is short and
 * owes nothing to `file`'s, so any name the folder takes, it takes too. The
 * temporary file is gone afterwards, whatever happened.
 */
const writeBeside = Effect.fn("files.writeBeside")(function* (
  file: string,
  data: string | Uint8Array,
  mode: number,
  place: (temporary: string) => Effect.Effect<void, PlatformError.PlatformError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const suffix = Hex.encode(yield* random.randomBytes(TEMPORARY_NAME_BYTES));
  const temporary = path.join(path.dirname(file), `.${suffix}.j3-writing`);
  const contents = typeof data === "string" ? new TextEncoder().encode(data) : data;
  yield* fs
    .writeFile(temporary, contents, { flag: "wx", mode })
    .pipe(
      Effect.andThen(place(temporary)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
}, Effect.provide(SecureRandom.layerWebCrypto));

/** Replaces `file` with `data`, whole. A link at `file` itself is replaced, not followed. */
export const replaceFile = Effect.fn("files.replaceFile")(function* (
  file: string,
  data: string | Uint8Array,
  mode: number,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* writeBeside(file, data, mode, (temporary) => fs.rename(temporary, file));
});

/**
 * Publishes `data` at `file`, whole, unless something is already there,
 * which is never replaced: a link, unlike a rename, fails rather than replace
 * what is at `file`, so of two writers that race, one publishes and the other
 * leaves the first's file as it is.
 */
export const publishFile = Effect.fn("files.publishFile")(function* (
  file: string,
  data: string | Uint8Array,
  mode: number,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* writeBeside(file, data, mode, (temporary) =>
    fs.link(temporary, file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    ),
  );
});
