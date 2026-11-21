// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Opening a file so that a link at its name is refused takes O_NOFOLLOW, which Effect's FileSystem cannot pass.
import * as NodeFs from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
 * The adapter's writes and removals of private state. Each checks its folder
 * with the caller's containment check first, and a refusal is logged where it
 * happens.
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
  /**
   * Checks `file` as `writeStream` does, before anything is fetched to write
   * there: its folder is created and checked, and `file` itself is checked
   * and must be a regular file or absent. The bytes it already holds; 0 when
   * absent.
   */
  readonly writable: (file: string) => Effect.Effect<number, StorageError>;
  /**
   * Writes `bytes` into `file` (mode 0600 if created), after what it already
   * holds when `append`, or from empty. `file` is checked as `writable`
   * checks it, and opened so that a link at its name is refused, never
   * followed, even one made after the check. An interruption lets the chunk
   * being written finish before the file is closed.
   */
  readonly writeStream: <E>(
    file: string,
    append: boolean,
    bytes: Stream.Stream<Uint8Array, E>,
  ) => Effect.Effect<void, StorageError | E>;
  /**
   * Removes `location`, with everything in it if it is a folder, once the
   * folder that holds it passes the check. A link at `location` is removed
   * itself, never what it leads to; a missing one is fine.
   */
  readonly remove: (location: string) => Effect.Effect<void, StorageError>;
  /**
   * Makes a symbolic link at `location` that leads to `target`, a path
   * relative to `location`'s folder. Both are checked first: the folder that
   * holds the link, and where `target` really is, links resolved, so a link
   * the adapter makes never leads out of private state when it is made.
   * Nothing may be at `location` yet: a link is never made over anything.
   */
  readonly link: (location: string, target: string) => Effect.Effect<void, StorageError>;
}

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

/** A failed `node:fs` call on `file`, as the `PlatformError` Effect's FileSystem fails with. */
const fsFailure = (method: string, file: string, cause: NodeJS.ErrnoException) =>
  PlatformError.systemError({
    _tag:
      cause.code === "ENOENT"
        ? "NotFound"
        : cause.code === "EACCES"
          ? "PermissionDenied"
          : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: file,
    syscall: cause.syscall,
    cause,
  });

/** Opens `file` with `flags` (mode 0600 if created). */
const openFile = (file: string, flags: number) =>
  Effect.callback<number, NodeJS.ErrnoException>((resume) => {
    NodeFs.open(file, flags, 0o600, (error, fd) => {
      resume(error === null ? Effect.succeed(fd) : Effect.fail(error));
    });
  });

const closeFile = (fd: number) =>
  Effect.callback<void>((resume) => {
    NodeFs.close(fd, () => resume(Effect.void));
  });

/** Writes the whole of `chunk` to `fd`, however many writes that takes. */
const writeAll = (file: string, fd: number, chunk: Uint8Array) =>
  Effect.callback<void, PlatformError.PlatformError>((resume) => {
    const from = (offset: number) => {
      if (offset >= chunk.byteLength) return resume(Effect.void);
      NodeFs.write(fd, chunk, offset, chunk.byteLength - offset, null, (error, written) => {
        if (error === null) from(offset + written);
        else resume(Effect.fail(fsFailure("write", file, error)));
      });
    };
    from(0);
  });

export const makePrivateFiles = Effect.fnUntraced(function* (
  isPrivate: (location: string) => Effect.Effect<boolean>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const refuse = Effect.fnUntraced(function* (location: string) {
    const exposed = new StorageExposed({ location });
    yield* Effect.logWarning(exposed.message);
    return yield* exposed;
  });

  const folder = Effect.fnUntraced(function* (location: string) {
    if (!(yield* isPrivate(location))) return yield* refuse(location);
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
  });

  const remove = Effect.fnUntraced(function* (location: string) {
    const parent = path.dirname(location);
    if (!(yield* isPrivate(parent))) return yield* refuse(parent);
    yield* fs.remove(location, { recursive: true, force: true });
  });

  const write = Effect.fnUntraced(function* (file: string, contents: string) {
    const parent = path.dirname(file);
    yield* folder(parent);
    const suffix = Hex.encode(yield* random.randomBytes(TEMPORARY_NAME_BYTES));
    const temporary = path.join(parent, `.${suffix}.j3-writing`);
    yield* fs.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.onError(() => remove(temporary).pipe(Effect.ignore)),
    );
  });

  const writable = Effect.fnUntraced(function* (file: string) {
    yield* folder(path.dirname(file));
    if (!(yield* isPrivate(file))) return yield* refuse(file);
    const existing = yield* fs.lstat(file).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(existing)) return 0;
    if (existing.value.type !== "File") return yield* refuse(file);
    return Number(existing.value.size);
  });

  const writeStream = <E>(
    file: string,
    append: boolean,
    bytes: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<void, StorageError | E> =>
    Effect.gen(function* () {
      yield* writable(file);
      const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_APPEND, O_TRUNC } = NodeFs.constants;
      const flags = O_WRONLY | O_CREAT | O_NOFOLLOW | (append ? O_APPEND : O_TRUNC);
      const fd = yield* Effect.acquireRelease(
        openFile(file, flags).pipe(
          // ELOOP: a link was put at `file` after the check.
          Effect.catch((error): Effect.Effect<never, StorageError> =>
            error.code === "ELOOP" ? refuse(file) : Effect.fail(fsFailure("open", file, error)),
          ),
        ),
        closeFile,
      );
      // Interrupting a write leaves Node's `fs.write` running: closing the
      // descriptor under it could let it land in whatever file reuses the
      // number. So each chunk, with its short-write continuation, finishes
      // first; the stream stays interruptible between chunks.
      yield* Stream.runForEach(bytes, (chunk) => Effect.uninterruptible(writeAll(file, fd, chunk)));
    }).pipe(Effect.scoped);

  const link = Effect.fnUntraced(function* (location: string, target: string) {
    const parent = path.dirname(location);
    yield* folder(parent);
    const destination = path.resolve(parent, target);
    if (!(yield* isPrivate(destination))) return yield* refuse(destination);
    yield* fs.symlink(target, location);
  });

  return { folder, write, writable, writeStream, remove, link } satisfies PrivateFiles;
});
