// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 of a 190 MB archive needs an incremental hash; Effect has none.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { boundedCommand } from "./Command.ts";
import { holdExclusive } from "./Lock.ts";
import { archiveName, pin, releaseUrl } from "./Pin.ts";
import { engineFolders, makePrivateFiles, type PrivateFiles } from "./PrivateFiles.ts";

// Installs the pinned engine release into the J3-owned engine home:
//
//   <home>/j3/runtime/<version>/t3       the standalone server
//   <home>/j3/runtime/<version>.partial  an interrupted download, resumed next time
//   <home>/j3/runtime/<version>.staging  where it is unpacked
//   <home>/j3/runtime/<version>.lock     held by the one install of that version running
//
// Two installs of one version can be started at once, as the server's first
// start and `j3-bots engine fetch` during an update are. The second waits for
// the first's lock, then finds the version installed.
//
// The engine's own `runtime/` folder belongs to its service launcher and
// updater, so J3 Bots keeps its copy under `j3/`, which the engine never reads.
// The owner's own `t3` on the PATH is never used.

/**
 * Why the pinned engine could not be installed. Retrying may help for every
 * reason but `unsupported-platform`. `storage`: a file under the engine's data
 * directory could not be written, as on a full disk.
 */
export class EngineInstallFailed extends Schema.TaggedError<EngineInstallFailed>()(
  "EngineInstallFailed",
  {
    reason: Schema.Literals(["unsupported-platform", "download", "checksum", "extract", "storage"]),
    version: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-platform":
        return `T3 Code ${this.version} has no release for this platform.`;
      case "download":
        return `Downloading T3 Code ${this.version} failed.`;
      case "checksum":
        return `The T3 Code ${this.version} download is not the archive J3 Bots pins.`;
      case "extract":
        return `Unpacking T3 Code ${this.version} failed.`;
      case "storage":
        return `Writing T3 Code ${this.version} to disk failed.`;
    }
  }
}

const RELEASE_PLATFORMS: Record<string, Record<string, string>> = {
  linux: { x64: "linux-x64", arm64: "linux-arm64" },
  darwin: { arm64: "darwin-arm64" },
};

/**
 * The release's archive for a Node `process.platform` and `process.arch`, and
 * the digest `sha256` pins for it, if the release ships one and it has one.
 */
const pinnedArchive = (
  sha256: Readonly<Record<string, string>>,
  platform: string,
  arch: string,
): Option.Option<{ readonly name: string; readonly digest: string }> =>
  Option.fromNullishOr(RELEASE_PLATFORMS[platform]?.[arch]).pipe(
    Option.flatMap((releasePlatform) =>
      Option.map(Option.fromNullishOr(sha256[releasePlatform]), (digest) => ({
        name: archiveName(releasePlatform),
        digest,
      })),
    ),
  );

const runtimeDirectory = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).runtime, pin.version);

const INSTALLED_MARKER = ".installed";

/**
 * Whether the pinned engine is installed under `home`, without installing it
 * or starting it: what `j3-bots doctor` reports.
 */
export type EngineInstall =
  | { readonly _tag: "installed"; readonly version: string; readonly executable: string }
  /** The server downloads it, from `source`, on its first start. */
  | { readonly _tag: "missing"; readonly version: string; readonly source: string }
  /** No release of the pinned version runs on this platform. */
  | { readonly _tag: "unsupported-platform"; readonly version: string };

export const inspectInstall = Effect.fn("engine.inspectInstall")(function* (input: {
  readonly home: string;
  readonly platform: string;
  readonly arch: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = runtimeDirectory(path, input.home);
  const installed = yield* fs
    .exists(path.join(target, INSTALLED_MARKER))
    .pipe(Effect.orElseSucceed(() => false));
  if (installed) {
    return {
      _tag: "installed",
      version: pin.version,
      executable: path.join(target, "t3"),
    } satisfies EngineInstall;
  }
  return Option.match(pinnedArchive(pin.sha256, input.platform, input.arch), {
    onNone: (): EngineInstall => ({ _tag: "unsupported-platform", version: pin.version }),
    onSome: (archive): EngineInstall => ({
      _tag: "missing",
      version: pin.version,
      source: releaseUrl(archive.name),
    }),
  });
});

/**
 * The pinned engine executable, installed if missing. Idempotent: a finished
 * install is detected by its marker, and what an install cut off after it was
 * published left beside it (its download, its unpacking folder) is removed.
 * Resumable: an interrupted download continues from where it stopped. One
 * install of the version runs at a time, under its lock (above); another
 * waits for it.
 *
 * `sha256` holds the archive digest for each release platform: the pin's own,
 * `pin.sha256`. The archive is installed only if it has that digest, and a
 * platform it has none for is `unsupported-platform`.
 */
export const ensureInstalled = Effect.fn("engine.ensureInstalled")(function* (input: {
  readonly home: string;
  readonly platform: string;
  readonly arch: string;
  readonly sha256: Readonly<Record<string, string>>;
  readonly files: PrivateFiles;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (reason: EngineInstallFailed["reason"]) =>
    new EngineInstallFailed({ reason, version: pin.version });
  const storage = () => fail("storage");
  const remove = (location: string) => input.files.remove(location).pipe(Effect.mapError(storage));

  const target = runtimeDirectory(path, input.home);
  const executable = path.join(target, "t3");
  const partial = `${target}.partial`;
  const staging = `${target}.staging`;
  const lock = `${target}.lock`;
  const published = fs
    .exists(path.join(target, INSTALLED_MARKER))
    .pipe(Effect.orElseSucceed(() => false));
  // A leftover only takes space: the installed engine runs whether or not it goes.
  const clearLeftovers = Effect.forEach(
    [partial, staging],
    (leftover) =>
      input.files
        .remove(leftover)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`Removing ${leftover}, left by an earlier install, failed`, cause),
          ),
        ),
    { discard: true },
  );
  if (yield* published) {
    yield* clearLeftovers;
    return executable;
  }

  const pinned = pinnedArchive(input.sha256, input.platform, input.arch);
  if (Option.isNone(pinned)) return yield* fail("unsupported-platform");
  const { name: archive, digest: expected } = pinned.value;

  // Checked as the download is: a link or a folder there fails at once.
  yield* input.files.writable(lock).pipe(Effect.mapError(storage));
  return yield* Effect.gen(function* () {
    yield* holdExclusive(lock).pipe(
      Effect.tapError((cause) => Effect.logWarning(`Locking ${lock} failed`, cause)),
      Effect.mapError(storage),
    );
    // Another install may have finished while this one waited for the lock.
    if (yield* published) {
      yield* clearLeftovers;
      return executable;
    }

    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
    const download = (cause: unknown) =>
      Effect.logWarning("Engine download failed", cause).pipe(
        Effect.andThen(Effect.fail(fail("download"))),
      );

    // Checked before anything is fetched, so a link or a folder there fails at
    // once rather than after a large download; the write itself checks again.
    const have = yield* input.files.writable(partial).pipe(Effect.mapError(storage));

    // Resume with a range request; a server that ignores it sends the whole file again.
    const response = yield* client
      .execute(
        HttpClientRequest.get(releaseUrl(archive)).pipe(
          have > 0 ? HttpClientRequest.setHeader("Range", `bytes=${have}-`) : (request) => request,
        ),
      )
      .pipe(Effect.catch(download));
    const appending = have > 0 && response.status === 206;
    if (!appending && response.status !== 200 && response.status !== 416) {
      return yield* download(`status ${response.status}`);
    }
    if (response.status !== 416) {
      yield* input.files
        .writeStream(
          partial,
          appending,
          response.stream.pipe(Stream.catch((cause) => Stream.fromEffect(download(cause)))),
        )
        .pipe(Effect.catchTags({ StorageExposed: storage, PlatformError: storage }));
    }

    // Checked again before it is read: the download may have taken long.
    yield* input.files.writable(partial).pipe(Effect.mapError(storage));
    const hash = NodeCrypto.createHash("sha256");
    yield* fs.stream(partial).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      Effect.mapError(storage),
    );
    if (hash.digest("hex") !== expected) {
      // A corrupt partial would fail the same way forever; start over next time.
      yield* remove(partial);
      return yield* fail("checksum");
    }

    // The runtime folder is checked again: the download may have taken long.
    // Whatever is at the staging name is removed (a link itself, never what it
    // leads to), and the folder is then created only if nothing is there, so a
    // link planted in between is never followed into.
    yield* input.files.folder(path.dirname(staging)).pipe(Effect.mapError(storage));
    yield* remove(staging);
    yield* fs.makeDirectory(staging, { mode: 0o700 }).pipe(Effect.mapError(storage));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // tar says why it failed, such as a full disk, on the server's stderr,
    // which the journal keeps; a tar that could not run is logged here.
    const exit = yield* spawner
      .exitCode(
        boundedCommand("tar", ["-xzf", partial, "-C", staging], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Running tar to unpack the engine failed", cause),
        ),
        Effect.orElseSucceed(() => -1),
      );
    if (exit !== 0) return yield* fail("extract");

    // The archive holds the server either at its root or in one top-level folder.
    const entries = yield* fs.readDirectory(staging).pipe(Effect.mapError(storage));
    const root =
      entries.includes("t3") || entries.length !== 1 || entries[0] === undefined
        ? staging
        : path.join(staging, entries[0]);
    if (!(yield* fs.exists(path.join(root, "t3")).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* fail("extract");
    }
    yield* fs
      .writeFileString(path.join(root, INSTALLED_MARKER), `${expected}\n`)
      .pipe(Effect.mapError(storage));
    yield* remove(target);
    yield* fs.rename(root, target).pipe(Effect.mapError(storage));
    yield* remove(staging);
    yield* remove(partial);
    return executable;
  }).pipe(Effect.scoped);
});

/**
 * `ensureInstalled` for this machine, into `home`, which is created private
 * first if it is missing: what the engine runs before its first start.
 */
export const installForThisMachine = Effect.fn("engine.installForThisMachine")(function* (
  home: string,
  files: PrivateFiles,
) {
  yield* files
    .folder(home)
    .pipe(
      Effect.mapError(() => new EngineInstallFailed({ reason: "storage", version: pin.version })),
    );
  return yield* ensureInstalled({
    home,
    platform: process.platform,
    arch: process.arch,
    sha256: pin.sha256,
    files,
  });
});

/**
 * Installs the pinned engine under `home` without starting it, when it is not
 * installed yet: `j3-bots engine fetch`, so a new release's engine can be in
 * place before the server that runs it starts. Every write goes through
 * `isPrivate`, as the running engine's do. Answers whether it was installed
 * already and where its executable is.
 */
export const fetchPinned = Effect.fn("engine.fetchPinned")(function* (options: {
  readonly home: string;
  readonly isPrivate: (location: string) => Effect.Effect<boolean>;
}) {
  const before = yield* inspectInstall({
    home: options.home,
    platform: process.platform,
    arch: process.arch,
  });
  const files = yield* makePrivateFiles(options.isPrivate).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const executable = yield* installForThisMachine(options.home, files);
  return {
    version: pin.version,
    executable,
    alreadyInstalled: before._tag === "installed",
  };
});

/**
 * Removes each engine release installed under `home` that is not one of
 * `keep`, by version: what an update of J3 Bots leaves is the engine of the
 * release it installed and of the one before it, which a rollback starts
 * again. Only a folder an install finished is removed; anything else in the
 * runtime folder stays. Answers the versions it removed.
 */
export const pruneRuntimes = Effect.fn("engine.pruneRuntimes")(function* (options: {
  readonly home: string;
  readonly keep: ReadonlyArray<string>;
  readonly isPrivate: (location: string) => Effect.Effect<boolean>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = engineFolders(path, options.home).runtime;
  const files = yield* makePrivateFiles(options.isPrivate).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const removed: Array<string> = [];
  for (const version of yield* fs.readDirectory(runtime).pipe(Effect.orElseSucceed(() => []))) {
    if (options.keep.includes(version)) continue;
    const folder = path.join(runtime, version);
    const finished = yield* fs
      .exists(path.join(folder, INSTALLED_MARKER))
      .pipe(Effect.orElseSucceed(() => false));
    if (!finished) continue;
    yield* files.remove(folder);
    removed.push(version);
  }
  return removed;
});
