// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HOME_ENTRIES } from "../home/entries.ts";

// What `j3-bots update` copies before it starts another release, and puts back
// if that release never becomes ready, or when the operator asks
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md):
//
//   <home>/backups/<taken>-<from>-to-<to>/
//     manifest.json                 what it is: SnapshotManifest
//     config.json  j3.sqlite[-wal|-shm]
//     engine/userdata/statev2.sqlite[-wal|-shm]  engine/userdata/settings.json
//     restoring                     while a restore from it has not finished
//     replaced-<time>-<random>/     what a restore moved out of the home
//
// Each file keeps its path relative to the home. Everything in it is this
// user's alone: folders 0700, files 0600. It is taken with the service
// stopped, so the databases and their logs agree, and flushed to the disk
// before its manifest is written: a folder without a manifest is not a
// snapshot. Bot files are not in it.

/** The manifest of a snapshot, in its folder. */
const MANIFEST = "manifest.json";

/** In a snapshot's folder from before a restore from it changes the home until that restore ends. */
const RESTORING = "restoring";

/** A release, as a snapshot names it. */
const SnapshotRelease = Schema.Struct({
  version: Schema.String,
  /** The engine release it is pinned to, when its `release.json` says. */
  engine: Schema.optionalKey(Schema.String),
});
export type SnapshotRelease = typeof SnapshotRelease.Type;

const SnapshotManifest = Schema.Struct({
  takenAt: Schema.DateTimeUtc,
  /** The release that ran on these files, and that a rollback starts again. */
  from: SnapshotRelease,
  /** The release the update installed. */
  to: SnapshotRelease,
  /** The files copied, by path relative to the home. */
  files: Schema.Array(Schema.String),
});
type SnapshotManifest = typeof SnapshotManifest.Type;

const ManifestJson = Schema.fromJsonString(Schema.toCodecJson(SnapshotManifest));

export interface Snapshot {
  readonly folder: string;
  readonly manifest: SnapshotManifest;
  /**
   * A restore from it moved files out of the home and did not finish: the
   * home holds part of the snapshot, so no server may run on it until a
   * restore from this snapshot ends.
   */
  readonly restoring: boolean;
}

/** When a snapshot was taken, as the operator reads it: `2026-05-04 09:30:12 UTC`. */
export const takenAt = (snapshot: Snapshot) =>
  DateTime.formatIso(snapshot.manifest.takenAt)
    .replace(/\.\d+Z$/, " UTC")
    .replace("T", " ");

/** A snapshot could not be taken or put back. */
class SnapshotFailed extends Schema.TaggedError<SnapshotFailed>()("SnapshotFailed", {
  action: Schema.Literals(["take", "restore"]),
  /** The file or folder it failed on. */
  location: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.action === "take"
      ? `Copying ${this.location} into a snapshot failed, so the snapshot was not kept.`
      : `Putting ${this.location} back from the snapshot failed.`;
  }
}

/**
 * The files a snapshot copies when they exist, by path relative to the home:
 * the configuration, J3 Bots' database with its write-ahead log, and the
 * engine's own state (`stateFiles`).
 */
const snapshotFiles = (path: Path.Path, home: string): ReadonlyArray<string> => [
  HOME_ENTRIES.config,
  HOME_ENTRIES.database,
  HOME_ENTRIES.databaseLog,
  HOME_ENTRIES.databaseLogIndex,
  ...EngineLive.stateFiles(path, path.join(home, HOME_ENTRIES.engine)).map((file) =>
    path.relative(home, file),
  ),
];

/** How many bytes the files at `files`, by path relative to `folder`, take now. */
const bytesOf = Effect.fnUntraced(function* (folder: string, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let total = 0;
  for (const file of files) {
    const info = yield* fs.stat(path.join(folder, file)).pipe(Effect.option);
    if (Option.isSome(info)) total += Number(info.value.size);
  }
  return total;
});

/** How many bytes the files a snapshot copies take now. */
export const snapshotBytes = Effect.fn("snapshot.bytes")(function* (home: string) {
  return yield* bytesOf(home, snapshotFiles(yield* Path.Path, home));
});

/** How many bytes a restore from `snapshot` copies into the home. */
export const restoreBytes = (snapshot: Snapshot) =>
  bytesOf(snapshot.folder, snapshot.manifest.files);

/**
 * Flushes `location`, a file or a folder, to the disk: what was written to
 * the file, or the names made or moved in the folder, survive a power cut.
 */
const flush = (location: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* (yield* FileSystem.FileSystem).open(location, { flag: "r" });
      yield* file.sync;
    }),
  );

/** Each folder from the folder of each of `files` up to `root`, `root` included. */
const foldersUpTo = (path: Path.Path, root: string, files: ReadonlyArray<string>) => {
  const folders = new Set<string>([root]);
  for (const file of files) {
    for (let folder = path.dirname(file); folder.startsWith(`${root}/`);) {
      folders.add(folder);
      folder = path.dirname(folder);
    }
  }
  return [...folders];
};

/** `2026-11-22T10:15:00.000Z` as `20261122T101500Z`: a name that sorts as time does. */
const compact = (time: DateTime.Utc) =>
  DateTime.formatIso(time)
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(/[-:]/g, "");

/** Copies `from` to the new file `to`, mode 0600, creating its folders (0700). */
const copyPrivate = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(to), { recursive: true, mode: 0o700 });
  yield* fs.stream(from).pipe(Stream.run(fs.sink(to, { flag: "wx", mode: 0o600 })));
  yield* fs.chmod(to, 0o600);
});

/**
 * Copies the files of `snapshotFiles` that exist in `home` into a new folder
 * of `<home>/backups`, flushed to the disk, then writes its manifest. Taken
 * with no server running on `home`. A file that is not a plain file fails
 * it, and a snapshot that fails is removed whole.
 */
export const takeSnapshot = Effect.fn("snapshot.take")(function* (options: {
  readonly home: string;
  readonly from: SnapshotRelease;
  readonly to: SnapshotRelease;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = options;
  const takenAt = yield* DateTime.now;
  const backups = path.join(home, HOME_ENTRIES.backups);
  const folder = path.join(
    backups,
    `${compact(takenAt)}-${options.from.version}-to-${options.to.version}`,
  );
  const failed = (location: string) => (cause: unknown) =>
    new SnapshotFailed({ action: "take", location, cause });

  yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(fs.chmod(backups, 0o700)),
    // Not recursive: two updates never share a snapshot.
    Effect.andThen(fs.makeDirectory(folder, { mode: 0o700 })),
    Effect.mapError(failed(folder)),
  );
  return yield* Effect.gen(function* () {
    yield* fs.chmod(folder, 0o700).pipe(Effect.mapError(failed(folder)));
    const files: Array<string> = [];
    for (const file of snapshotFiles(path, home)) {
      const source = path.join(home, file);
      const info = yield* fs.lstat(source).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type !== "File") return yield* failed(source)("not a plain file");
      const copy = path.join(folder, file);
      yield* copyPrivate(source, copy).pipe(
        Effect.andThen(flush(copy)),
        Effect.mapError(failed(source)),
      );
      files.push(file);
    }
    const manifest: SnapshotManifest = { takenAt, from: options.from, to: options.to, files };
    const manifestFile = path.join(folder, MANIFEST);
    yield* Schema.encodeEffect(ManifestJson)(manifest).pipe(
      Effect.flatMap((text) => fs.writeFileString(manifestFile, text, { flag: "wx", mode: 0o600 })),
      Effect.andThen(fs.chmod(manifestFile, 0o600)),
      Effect.andThen(flush(manifestFile)),
      Effect.andThen(
        Effect.forEach(
          [
            ...foldersUpTo(
              path,
              folder,
              [...files, MANIFEST].map((file) => path.join(folder, file)),
            ),
            backups,
          ],
          flush,
          { discard: true },
        ),
      ),
      Effect.mapError(failed(manifestFile)),
    );
    return { folder, manifest, restoring: false } satisfies Snapshot;
  }).pipe(
    Effect.onError(() => fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/**
 * Puts the files of `snapshot` back in `home`, with no server running on it,
 * in an order a cut at any point cannot turn into a home a server runs on:
 *
 * 1. Every file of the snapshot is copied beside where it goes, under a
 *    temporary name, and flushed. A failure here removes the copies and
 *    leaves the home as it was.
 * 2. The snapshot is marked `restoring`: from here until the end the home
 *    holds part of it. Pruning keeps a snapshot so marked, an update refuses
 *    to start, and `j3-bots update --rollback` restores from it again.
 * 3. Every file a snapshot would copy that is in the home now is moved into
 *    `replaced-*` in the snapshot's folder, never deleted: a file the
 *    snapshot does not have, such as a write-ahead log the release it
 *    replaces left, must not stay beside the database put back.
 * 4. The copies are renamed into place, the folders flushed, and the mark
 *    removed.
 */
export const restoreSnapshot = Effect.fn("snapshot.restore")(function* (
  home: string,
  snapshot: Snapshot,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = (location: string) => (cause: unknown) =>
    new SnapshotFailed({ action: "restore", location, cause });
  const flushAll = (folders: Iterable<string>) =>
    Effect.forEach(folders, (folder) => flush(folder).pipe(Effect.mapError(failed(folder))), {
      discard: true,
    });
  const placed = snapshot.manifest.files.map((file) => ({
    source: path.join(snapshot.folder, file),
    copy: `${path.join(home, file)}.j3-restoring`,
    current: path.join(home, file),
  }));

  yield* Effect.forEach(
    placed,
    ({ source, copy, current }) =>
      fs
        .remove(copy, { force: true })
        .pipe(
          Effect.andThen(copyPrivate(source, copy)),
          Effect.andThen(flush(copy)),
          Effect.mapError(failed(current)),
        ),
    { discard: true },
  ).pipe(
    Effect.onError(() =>
      Effect.forEach(placed, ({ copy }) => fs.remove(copy, { force: true }), {
        discard: true,
      }).pipe(Effect.ignore),
    ),
  );
  const homeFolders = foldersUpTo(
    path,
    home,
    placed.map(({ current }) => current),
  );
  yield* flushAll(homeFolders);

  const marker = path.join(snapshot.folder, RESTORING);
  yield* fs
    .writeFileString(marker, `${DateTime.formatIso(yield* DateTime.now)}\n`, { mode: 0o600 })
    .pipe(Effect.andThen(flush(marker)), Effect.mapError(failed(marker)));
  yield* flushAll([snapshot.folder]);

  const replaced = yield* fs
    .makeTempDirectory({
      directory: snapshot.folder,
      prefix: `replaced-${compact(yield* DateTime.now)}-`,
    })
    .pipe(Effect.mapError(failed(snapshot.folder)));
  const left: Array<string> = [];
  const asides: Array<string> = [];
  for (const file of snapshotFiles(path, home)) {
    const current = path.join(home, file);
    if (Option.isNone(yield* fs.lstat(current).pipe(Effect.option))) continue;
    const aside = path.join(replaced, file);
    yield* fs
      .makeDirectory(path.dirname(aside), { recursive: true, mode: 0o700 })
      .pipe(Effect.andThen(fs.rename(current, aside)), Effect.mapError(failed(current)));
    left.push(current);
    asides.push(aside);
  }
  yield* flushAll(
    new Set([...foldersUpTo(path, home, left), ...foldersUpTo(path, snapshot.folder, asides)]),
  );

  for (const { copy, current } of placed) {
    yield* fs.rename(copy, current).pipe(Effect.mapError(failed(current)));
  }
  yield* flushAll(homeFolders);
  yield* fs.remove(marker).pipe(Effect.mapError(failed(marker)));
  yield* flushAll([snapshot.folder]);
});

/** The snapshots in `home`, newest first. A folder whose manifest does not decode is not one. */
export const listSnapshots = Effect.fn("snapshot.list")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const backups = path.join(home, HOME_ENTRIES.backups);
  const snapshots: Array<Snapshot> = [];
  for (const name of yield* fs.readDirectory(backups).pipe(Effect.orElseSucceed(() => []))) {
    const folder = path.join(backups, name);
    const manifest = yield* fs
      .readFileString(path.join(folder, MANIFEST))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ManifestJson)), Effect.option);
    if (Option.isNone(manifest)) continue;
    // A marker that cannot be read counts as one: keeping a snapshot is the safe side.
    const restoring = yield* fs
      .exists(path.join(folder, RESTORING))
      .pipe(Effect.orElseSucceed(() => true));
    snapshots.push({ folder, manifest: manifest.value, restoring });
  }
  return snapshots.sort((a, b) => DateTime.Order(b.manifest.takenAt, a.manifest.takenAt));
});

/**
 * The snapshot `--rollback` puts back in `home` while `running` runs: the one
 * a restore has not finished from, if there is one, since the home holds
 * part of it; otherwise the newest taken by an update to `running`. An update
 * that failed and rolled itself back took a newer one, to a release that
 * does not run, which this passes over. `None` when there is none.
 */
export const rollbackSnapshot = Effect.fn("snapshot.rollbackSnapshot")(function* (
  home: string,
  running: string,
) {
  const snapshots = yield* listSnapshots(home);
  return Option.fromNullishOr(
    snapshots.find(({ restoring }) => restoring) ??
      snapshots.find(({ manifest }) => manifest.to.version === running),
  );
});

/**
 * Removes every snapshot in `home` but the newest `keep`, each with what its
 * restores replaced, in its `replaced-*` folders. A snapshot a restore has not
 * finished from is kept. Anything else in `backups` stays.
 */
export const pruneSnapshots = Effect.fn("snapshot.prune")(function* (home: string, keep: number) {
  const fs = yield* FileSystem.FileSystem;
  const older = (yield* listSnapshots(home)).slice(keep).filter(({ restoring }) => !restoring);
  for (const { folder } of older) yield* fs.remove(folder, { recursive: true });
  return older;
});
