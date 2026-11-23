// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
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
// copied to `<userData>/server-runtime/<version>/` first, the previous one is
// kept, and older ones are removed.
//
// On Windows the firewall remembers an executable by its path, so a server
// that listens beyond loopback runs from `<userData>/server-runtime/current/`,
// a copy of the version that runs, put in place by rename.

/** What `scripts/build-release.ts` writes to `release.json`: the fields the app reads. */
const RuntimeManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^[0-9A-Za-z.+-]{1,64}$/)),
});
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
class RuntimeNotReady extends Schema.TaggedError<RuntimeNotReady>()("RuntimeNotReady", {
  reason: Schema.Literals(["missing", "damaged", "not-copied"]),
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

/** The version of the runtime at `root`, as its `release.json` says it. */
export const versionOf = Effect.fn("Runtime.versionOf")(function* (root: string) {
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
  return manifest.value.version;
});

/** How many versions stay in `<userData>/server-runtime`: the one that runs, and the one before it. */
const KEPT = 2;
const CURRENT = "current";
/** Marks a copy that is whole: written last, after every file. */
const COMPLETE = ".complete";

export interface InstallOptions {
  /** The runtime the package carries. */
  readonly source: string;
  /** `<userData>/server-runtime`. */
  readonly folder: string;
  readonly platform: NodeJS.Platform;
}

/**
 * Puts the runtime at `source` in place under `folder`, unless the same
 * version already is, whole; removes all but the `KEPT` versions most
 * recently put in place; and answers where it is. On Windows it answers the
 * stable `current` copy, swapped in by rename when the version changed.
 *
 * A copy is made in a temporary folder and renamed into place once whole, so
 * a copy cut short (the app killed, the disk full) is never run, and is made
 * again next time.
 */
export const install = Effect.fn("Runtime.install")(function* (options: InstallOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const version = yield* versionOf(options.source);
  const notCopied = (error: { readonly message: string }) =>
    new RuntimeNotReady({ reason: "not-copied", detail: error.message });

  const target = path.join(options.folder, version);
  const whole = yield* fs
    .exists(path.join(target, COMPLETE))
    .pipe(Effect.orElseSucceed(() => false));
  if (!whole) {
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
  // The newest stays newest: its folder's time is when it was last chosen.
  const now = DateTime.toDateUtc(yield* DateTime.now);
  yield* fs.utimes(target, now, now).pipe(Effect.ignore);
  yield* prune(options.folder, version);

  if (options.platform !== "win32") return runtimeAt(path, target, version, options.platform);
  return yield* swapCurrent(options.folder, target, version).pipe(Effect.mapError(notCopied));
});

/** Removes every version but `keep` and the next most recently chosen, and leftover partial copies. */
const prune = Effect.fn("Runtime.prune")(function* (folder: string, keep: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
  const versions: Array<{ readonly name: string; readonly chosen: number }> = [];
  for (const name of names) {
    if (name === CURRENT || name.startsWith(".")) {
      if (name.endsWith(".partial") && name !== `.${keep}.partial`) {
        yield* fs
          .remove(path.join(folder, name), { recursive: true, force: true })
          .pipe(Effect.ignore);
      }
      continue;
    }
    const info = yield* fs.stat(path.join(folder, name)).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    versions.push({
      name,
      chosen: Option.match(info.value.mtime, { onNone: () => 0, onSome: (time) => time.getTime() }),
    });
  }
  const newestFirst = versions
    .filter((entry) => entry.name !== keep)
    .sort((a, b) => b.chosen - a.chosen);
  for (const old of newestFirst.slice(KEPT - 1)) {
    yield* fs
      .remove(path.join(folder, old.name), { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Removing the old server runtime ${old.name} failed`, error),
        ),
      );
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
