// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// The server runtime the app runs: the release's own Node and server bundle,
// which the package carries in `resources/server-runtime` (the release
// archive without its web client). It never runs from there: an AppImage's
// mount goes as the app exits while the server would still hold it, Windows
// will not let an update replace a running `node.exe`, and a rollback needs
// the previous version after the package was replaced. So each version is
// copied to `<userData>/server-runtime/<version>/` first. Which versions stay
// is the version transition's to say (`versionTransition.ts`): it keeps the
// two it moved between once the new one runs, and never removes the one the
// bots' data was last handed to.
//
// On Windows the firewall remembers an executable by its path, so a server
// that listens beyond loopback runs from `<userData>/server-runtime/current/`,
// a copy of the version that runs, put in place by rename.

/** A release's name, as `release.json` gives it: safe as a folder's name. */
const Version = Schema.String.check(Schema.isPattern(/^[0-9A-Za-z.+-]{1,64}$/));

/** What `scripts/build-release.ts` writes to `release.json`: the fields the app reads. */
const RuntimeManifest = Schema.Struct({
  version: Version,
  /** The engine release it pins, which a transition keeps the runtime of. */
  engine: Schema.optionalKey(Version),
});
export type RuntimeRelease = typeof RuntimeManifest.Type;
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeManifest));

/** Where a copy of the runtime lies, and the programs in it. */
export interface Runtime {
  readonly version: string;
  readonly root: string;
  /** The Node that runs the server. */
  readonly node: string;
  /** The server's entry point. */
  readonly entry: string;
}

/** The runtime could not be put in place, for the reason given. */
export class RuntimeNotReady extends Schema.TaggedError<RuntimeNotReady>()("RuntimeNotReady", {
  reason: Schema.Literals(["missing", "damaged", "not-copied", "not-kept"]),
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return `This copy of J3 Bots carries no server to run on this computer (${this.detail}).`;
      case "damaged":
        return `The server that comes with J3 Bots is damaged (${this.detail}). Install J3 Bots again.`;
      case "not-copied":
        return `The server could not be prepared to run: ${this.detail}`;
      case "not-kept":
        return `J3 Bots ${this.detail}, which the bots' data was last handed to, is no longer on this computer.`;
    }
  }
}

/** The Node in a runtime folder, on `platform`. */
const nodeIn = (path: Path.Path, root: string, platform: NodeJS.Platform) =>
  platform === "win32"
    ? path.join(root, "node", "node.exe")
    : path.join(root, "node", "bin", "node");

const runtimeAt = (
  path: Path.Path,
  root: string,
  version: string,
  platform: NodeJS.Platform,
): Runtime => ({
  version,
  root,
  node: nodeIn(path, root, platform),
  entry: path.join(root, "server", "bin.mjs"),
});

/** The release of the runtime at `root`, as its `release.json` says it. */
export const releaseOf = Effect.fn("Runtime.releaseOf")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(root, "release.json")).pipe(Effect.option);
  if (Option.isNone(text)) {
    return yield* new RuntimeNotReady({ reason: "missing", detail: root });
  }
  const manifest = decodeManifest(text.value);
  if (Option.isNone(manifest)) {
    return yield* new RuntimeNotReady({
      reason: "damaged",
      detail: path.join(root, "release.json"),
    });
  }
  return manifest.value;
});

const CURRENT = "current";
/** Marks a copy that is whole: written last, after every file. */
const COMPLETE = ".complete";

export interface InstallOptions {
  /** The runtime the package carries. */
  readonly source: string;
  /** `<userData>/server-runtime`. */
  readonly folder: string;
}

/**
 * Copies the runtime at `source` to `<folder>/<version>`, unless that version
 * is there already, whole, and removes copies other runs left cut short.
 * Answers its release; `ready` gives what runs it.
 *
 * A copy is made in a temporary folder and renamed into place once whole, so
 * a copy cut short (the app killed, the disk full) is never run, and is made
 * again next time.
 */
export const install = Effect.fn("Runtime.install")(function* (options: InstallOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = yield* releaseOf(options.source);
  const { version } = release;
  const target = path.join(options.folder, version);
  if (!(yield* isWhole(target))) {
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(options.folder, { recursive: true, mode: 0o700 });
      const staging = path.join(options.folder, `.${version}.partial`);
      yield* fs.remove(staging, { recursive: true, force: true });
      yield* fs.copy(options.source, staging, { overwrite: true });
      yield* fs.writeFileString(path.join(staging, COMPLETE), `${version}\n`);
      yield* fs.remove(target, { recursive: true, force: true });
      yield* fs.rename(staging, target);
    }).pipe(Effect.mapError(notCopied));
  }
  for (const name of yield* fs.readDirectory(options.folder).pipe(Effect.orElseSucceed(() => []))) {
    // Only a copy's own staging folder: a release's version never starts with a dot.
    if (name.startsWith(".") && name.endsWith(".partial")) {
      yield* fs
        .remove(path.join(options.folder, name), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  }
  return release;
});

const notCopied = (error: { readonly message: string }) =>
  new RuntimeNotReady({ reason: "not-copied", detail: error.message });

/** Whether the copy at `root` was made whole. */
const isWhole = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(root, COMPLETE)).pipe(Effect.orElseSucceed(() => false));
});

/** The versions whose runtime `folder` keeps whole. */
export const kept = Effect.fn("Runtime.kept")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions: Array<string> = [];
  for (const name of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
    if (name === CURRENT || name.startsWith(".")) continue;
    if (yield* isWhole(path.join(folder, name))) versions.push(name);
  }
  return versions;
});

export interface ReadyOptions {
  /** `<userData>/server-runtime`. */
  readonly folder: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The runtime of `version`, which `folder` keeps, ready to run: from its own
 * folder, or on Windows from the stable `current` copy, swapped in by
 * rename when it holds another version.
 */
export const ready = Effect.fn("Runtime.ready")(function* (options: ReadyOptions) {
  const path = yield* Path.Path;
  const target = path.join(options.folder, options.version);
  if (!(yield* isWhole(target))) {
    return yield* new RuntimeNotReady({ reason: "not-kept", detail: options.version });
  }
  if (options.platform !== "win32") {
    return runtimeAt(path, target, options.version, options.platform);
  }
  return yield* swapCurrent(options.folder, target, options.version).pipe(
    Effect.mapError(notCopied),
  );
});

export interface WebClientOptions {
  /** The web client the package carries. */
  readonly source: string;
  /** Where the server serves it from: `<userData>/server/web`. */
  readonly folder: string;
  /** The release it is the client of: the package's. */
  readonly version: string;
}

/**
 * Keeps a copy of the web client the package carries at `folder`, for the
 * server to serve to phones, and answers where it is. The server never
 * serves it from the package: an AppImage's mount goes as the app exits,
 * while a server it started may be taken over by the next run, and an
 * update replaces the package's files. The copy is made again only for
 * another release, beside the one there and renamed over it, and marked as
 * that release's (`<folder>.complete`) once in place.
 */
export const keepWebClient = Effect.fn("Runtime.keepWebClient")(function* (
  options: WebClientOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const { folder, version } = options;
  const marker = `${folder}${COMPLETE}`;
  const there = yield* fs.readFileString(marker).pipe(Effect.option);
  if (Option.isSome(there) && there.value.trim() === version) return folder;
  const staging = `${folder}.partial`;
  const retired = `${folder}.old`;
  yield* fs.remove(marker, { force: true });
  yield* fs.remove(staging, { recursive: true, force: true });
  yield* fs.copy(options.source, staging, { overwrite: true });
  yield* fs.remove(retired, { recursive: true, force: true });
  if (yield* fs.exists(folder)) yield* fs.rename(folder, retired);
  yield* fs.rename(staging, folder);
  yield* fs.writeFileString(marker, `${version}\n`);
  yield* fs.remove(retired, { recursive: true, force: true }).pipe(Effect.ignore);
  return folder;
}, Effect.mapError(notCopied));

/**
 * Removes the runtime of every version but `keep` from `folder`: what a
 * version transition does once the new version runs, keeping the two it
 * moved between.
 */
export const prune = Effect.fn("Runtime.prune")(function* (
  folder: string,
  keep: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const version of yield* kept(folder)) {
    if (keep.includes(version)) continue;
    yield* fs.remove(path.join(folder, version), { recursive: true, force: true });
  }
});

/**
 * Makes `<folder>/current` a copy of the version at `target`, unless it is
 * already. The new copy is made beside it and renamed over it, so the path
 * the firewall knows names a whole runtime at every moment but the rename.
 */
const swapCurrent = Effect.fn("Runtime.swapCurrent")(function* (
  folder: string,
  target: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = path.join(folder, CURRENT);
  const there = yield* fs.readFileString(path.join(current, COMPLETE)).pipe(Effect.option);
  if (Option.isSome(there) && there.value.trim() === version) {
    return runtimeAt(path, current, version, "win32");
  }
  const staging = path.join(folder, `.${CURRENT}.partial`);
  const retired = path.join(folder, `.${CURRENT}.old`);
  yield* fs.remove(staging, { recursive: true, force: true });
  yield* fs.copy(target, staging, { overwrite: true });
  yield* fs.remove(retired, { recursive: true, force: true });
  if (yield* fs.exists(current)) yield* fs.rename(current, retired);
  yield* fs.rename(staging, current);
  yield* fs.remove(retired, { recursive: true, force: true }).pipe(Effect.ignore);
  return runtimeAt(path, current, version, "win32");
});
