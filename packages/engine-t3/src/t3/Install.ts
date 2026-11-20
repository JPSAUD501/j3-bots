// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 of a 190 MB archive needs an incremental hash; Effect has none.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { archiveName, pin, releaseUrl } from "./Pin.ts";
import { engineFolders, type PrivateFiles } from "./PrivateFiles.ts";

// Installs the pinned engine release into the J3-owned engine home:
//
//   <home>/j3/runtime/<version>/t3      the standalone server
//   <home>/j3/runtime/<version>.partial  an interrupted download, resumed next time
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
        return `The T3 Code ${this.version} download does not match the release's checksum.`;
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

/** The release's name for a Node `process.platform` and `process.arch`, if it ships one. */
const releasePlatform = (platform: string, arch: string): Option.Option<string> =>
  Option.fromNullishOr(RELEASE_PLATFORMS[platform]?.[arch]);

const runtimeDirectory = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).runtime, pin.version);

/** The digest `SHA256SUMS` lists for `file`. */
const checksumFor = (sums: string, file: string): Option.Option<string> => {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === file && match[1] !== undefined) return Option.some(match[1]);
  }
  return Option.none();
};

const INSTALLED_MARKER = ".installed";

/**
 * Whether the pinned engine is installed under `home`, without installing it
 * or starting it: what `j3-bots doctor` reports.
 */
export type EngineInstall =
  | { readonly _tag: "installed"; readonly version: string; readonly executable: string }
  /** The server downloads it on its first start. */
  | { readonly _tag: "missing"; readonly version: string }
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
  return Option.isSome(releasePlatform(input.platform, input.arch))
    ? ({ _tag: "missing", version: pin.version } satisfies EngineInstall)
    : ({ _tag: "unsupported-platform", version: pin.version } satisfies EngineInstall);
});

/**
 * The pinned engine executable, installed if missing. Idempotent: a finished
 * install is detected by its marker and costs one `stat`. Resumable: an
 * interrupted download continues from where it stopped.
 */
export const ensureInstalled = Effect.fn("engine.ensureInstalled")(function* (input: {
  readonly home: string;
  readonly platform: string;
  readonly arch: string;
  readonly files: PrivateFiles;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (reason: EngineInstallFailed["reason"]) =>
    new EngineInstallFailed({ reason, version: pin.version });
  const storage = () => fail("storage");

  const target = runtimeDirectory(path, input.home);
  const executable = path.join(target, "t3");
  if (yield* fs.exists(path.join(target, INSTALLED_MARKER)).pipe(Effect.orElseSucceed(() => false)))
    return executable;

  const platform = releasePlatform(input.platform, input.arch);
  if (Option.isNone(platform)) return yield* fail("unsupported-platform");
  const archive = archiveName(platform.value);

  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const download = (cause: unknown) =>
    Effect.logWarning("Engine download failed", cause).pipe(
      Effect.andThen(Effect.fail(fail("download"))),
    );

  const sums = yield* client.get(releaseUrl("SHA256SUMS")).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.catch(download),
  );
  const expected = checksumFor(sums, archive);
  if (Option.isNone(expected)) return yield* fail("unsupported-platform");

  yield* input.files.folder(path.dirname(target)).pipe(Effect.mapError(storage));
  const partial = `${target}.partial`;
  // What a regular file there already holds; `files.writeStream` refuses anything else.
  const have = yield* fs.lstat(partial).pipe(
    Effect.map((info) => (info.type === "File" ? Number(info.size) : 0)),
    Effect.orElseSucceed(() => 0),
  );

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

  const hash = NodeCrypto.createHash("sha256");
  yield* fs.stream(partial).pipe(
    Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
    Effect.mapError(storage),
  );
  if (hash.digest("hex") !== expected.value) {
    // A corrupt partial would fail the same way forever; start over next time.
    yield* fs.remove(partial).pipe(Effect.ignore);
    return yield* fail("checksum");
  }

  const staging = `${target}.staging`;
  yield* fs.remove(staging, { recursive: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(staging, { recursive: true }).pipe(Effect.mapError(storage));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exit = yield* spawner
    .exitCode(ChildProcess.make("tar", ["-xzf", partial, "-C", staging]))
    .pipe(Effect.orElseSucceed(() => -1));
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
    .writeFileString(path.join(root, INSTALLED_MARKER), `${expected.value}\n`)
    .pipe(Effect.mapError(storage));
  yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore);
  yield* fs.rename(root, target).pipe(Effect.mapError(storage));
  yield* fs.remove(staging, { recursive: true }).pipe(Effect.ignore);
  yield* fs.remove(partial).pipe(Effect.ignore);
  return executable;
});
