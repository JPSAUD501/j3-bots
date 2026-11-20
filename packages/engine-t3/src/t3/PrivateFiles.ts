// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";

// What the adapter itself writes under the engine's data directory, and the
// one way it writes there. The engine writes the rest of that directory on
// its own; these are J3 Bots' writes.

/** The folders the adapter writes, by role, for an engine data directory at `home`. */
export const engineFolders = (path: Path.Path, home: string) => ({
  /** J3 Bots' own: the credential, the record of the engine process, the runtime. */
  j3: path.join(home, "j3"),
  /** The pinned engine release, installed by the adapter. */
  runtime: path.join(home, "j3", "runtime"),
  /** The engine's settings, provisioned by the adapter. */
  userdata: path.join(home, "userdata"),
  /** The harnesses' environment, one file per variable. */
  secrets: path.join(home, "userdata", "secrets"),
});

/**
 * Every folder the adapter writes under the engine's data directory, for the
 * caller to check at start like the rest of its private state. The harness
 * homes the caller names in `EngineOptions.providers` are checked as they are
 * written.
 */
export const writtenFolders = (path: Path.Path, home: string): ReadonlyArray<string> =>
  Object.values(engineFolders(path, home));

/** A folder the adapter was about to write in has left private state, by the caller's check. */
class StorageExposed extends Schema.TaggedError<StorageExposed>()("StorageExposed", {
  location: Schema.String,
}) {
  override get message(): string {
    return `${this.location} has left the server's private data, so the engine adapter did not write in it.`;
  }
}

type StorageError = StorageExposed | PlatformError.PlatformError;

/**
 * The adapter's writes of private state. Each checks its folder with the
 * caller's containment check first, and a refusal is logged where it happens.
 */
export interface PrivateFiles {
  /** Creates `folder` (mode 0700) if missing. */
  readonly folder: (folder: string) => Effect.Effect<void, StorageError>;
  /**
   * Replaces `file` whole with `contents` (mode 0600): writes a new file of a
   * random name in the checked folder, which must not exist yet, so a link
   * planted in its place is never followed, then renames it over `file`. A
   * link at `file` itself is replaced, not followed.
   */
  readonly write: (file: string, contents: string) => Effect.Effect<void, StorageError>;
}

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

export const makePrivateFiles = Effect.fnUntraced(function* (
  isPrivate: (location: string) => Effect.Effect<boolean>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const folder = Effect.fnUntraced(function* (location: string) {
    if (!(yield* isPrivate(location))) {
      const exposed = new StorageExposed({ location });
      yield* Effect.logWarning(exposed.message);
      return yield* exposed;
    }
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
  });

  const write = Effect.fnUntraced(function* (file: string, contents: string) {
    const parent = path.dirname(file);
    yield* folder(parent);
    const suffix = Hex.encode(yield* random.randomBytes(TEMPORARY_NAME_BYTES));
    const temporary = path.join(parent, `.${path.basename(file)}.${suffix}.j3-writing`);
    yield* fs.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
  });

  return { folder, write } satisfies PrivateFiles;
});
