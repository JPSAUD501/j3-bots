// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import { platformErrorCode, whileHeld } from "@j3-bots/processes";

// A file the server writes is never seen half-written: its contents go to a
// new file beside it first, which then takes its name. A full disk or a crash
// leaves at most that temporary file, never a partial one at the name.
// Windows refuses that rename while another program, such as a scanner
// looking at the new file, holds one of the two: it is tried again a while.

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

/** How a temporary file's name ends, after a dot and its random bytes. */
const TEMPORARY_SUFFIX = ".j3-writing";

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
  const temporary = path.join(path.dirname(file), `.${suffix}${TEMPORARY_SUFFIX}`);
  const contents = typeof data === "string" ? new TextEncoder().encode(data) : data;
  yield* fs
    .writeFile(temporary, contents, { flag: "wx", mode })
    .pipe(
      Effect.andThen(place(temporary)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
}, Effect.provide(SecureRandom.layerWebCrypto));

/**
 * Removes the temporary files a write in `folder` left when the server was
 * killed or lost power before it could remove them, as it otherwise always
 * does: one can hold what its file holds.
 */
export const removeLeftovers = Effect.fn("files.removeLeftovers")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of yield* fs.readDirectory(folder)) {
    if (name.startsWith(".") && name.endsWith(TEMPORARY_SUFFIX)) {
      yield* fs.remove(path.join(folder, name), { force: true });
    }
  }
});

/** Renames `from` to `to`, tried again while Windows says another program holds either (`whileHeld`). */
const renamePatiently = (fs: FileSystem.FileSystem, from: string, to: string) =>
  whileHeld(fs.rename(from, to), { platform: process.platform, codeOf: platformErrorCode });

/** Replaces `file` with `data`, whole. A link at `file` itself is replaced, not followed. */
export const replaceFile = Effect.fn("files.replaceFile")(function* (
  file: string,
  data: string | Uint8Array,
  mode: number,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* writeBeside(file, data, mode, (temporary) => renamePatiently(fs, temporary, file));
});

/**
 * Flushes the file `location` to the disk: what was written to it survives a
 * power cut. Windows flushes only a file opened for writing
 * (`FlushFileBuffers`), so there it is opened so, though nothing is written.
 */
export const flushFile = Effect.fn("files.flushFile")(function* (location: string) {
  const fs = yield* FileSystem.FileSystem;
  const flag = process.platform === "win32" ? "r+" : "r";
  yield* Effect.scoped(Effect.flatMap(fs.open(location, { flag }), (file) => file.sync));
});

/**
 * Flushes the folder `location` to the disk: the names made or moved in it
 * survive a power cut. Not on Windows, where a folder opened as Node opens
 * one cannot be flushed (the call fails with `EPERM`): there NTFS keeps those
 * names in its own journal, which it writes to the disk on its own schedule.
 */
export const flushFolder = Effect.fn("files.flushFolder")(function* (location: string) {
  if (process.platform === "win32") return;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(Effect.flatMap(fs.open(location, { flag: "r" }), (file) => file.sync));
});

/**
 * Replaces `file` with `data`, whole, as `replaceFile` does, and durably: the
 * new contents are flushed to the disk before they take the name, and the
 * folder after, so a power cut leaves the file before or this one, never an
 * empty one.
 */
export const replaceFileDurably = Effect.fn("files.replaceFileDurably")(function* (
  file: string,
  data: string | Uint8Array,
  mode: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writeBeside(file, data, mode, (temporary) =>
    flushFile(temporary).pipe(
      Effect.andThen(renamePatiently(fs, temporary, file)),
      Effect.andThen(flushFolder(path.dirname(file))),
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  );
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
