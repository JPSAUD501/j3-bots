// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- J3 Bots' migration head is read from its database read-only, which only node:sqlite opens.
import * as NodeSqlite from "node:sqlite";
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
//     replaced-<time>/              what a restore moved out of the home
//
// Each file keeps its path relative to the home. Everything in it is this
// user's alone: folders 0700, files 0600. It is taken with the service
// stopped, so the databases and their logs agree. Bot files are not in it.

/** The manifest of a snapshot, in its folder. */
const MANIFEST = "manifest.json";

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
  /** The highest J3 Bots migration the database recorded; none without a database. */
  migration: Schema.NullOr(Schema.Int),
  /** The highest migration the engine's database recorded; none without one. */
  engineMigration: Schema.NullOr(Schema.Int),
  /** The files copied, by path relative to the home. */
  files: Schema.Array(Schema.String),
});
type SnapshotManifest = typeof SnapshotManifest.Type;

const ManifestJson = Schema.fromJsonString(Schema.toCodecJson(SnapshotManifest));

export interface Snapshot {
  readonly folder: string;
  readonly manifest: SnapshotManifest;
}

/** A snapshot could not be taken, read or put back. */
/** When a snapshot was taken, as the operator reads it: `2026-05-04 09:30:12 UTC`. */
export const takenAt = (snapshot: Snapshot) =>
  DateTime.formatIso(snapshot.manifest.takenAt)
    .replace(/\.\d+Z$/, " UTC")
    .replace("T", " ");

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

/** How many bytes the files a snapshot copies take now. */
export const snapshotBytes = Effect.fn("snapshot.bytes")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let total = 0;
  for (const file of snapshotFiles(path, home)) {
    const info = yield* fs.stat(path.join(home, file)).pipe(Effect.option);
    if (Option.isSome(info)) total += Number(info.value.size);
  }
  return total;
});

/** The highest migration J3 Bots' database at `file` records, read without writing to it. */
const recordedHead = (file: string) =>
  Effect.sync(() => {
    try {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        // A database with no migrations table fails here, and records none.
        const row = database
          .prepare("SELECT max(migration_id) AS head FROM effect_sql_migrations")
          .get();
        const head = row?.["head"];
        return typeof head === "number" ? head : null;
      } finally {
        database.close();
      }
    } catch {
      return null;
    }
  });

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
 * of `<home>/backups`, with its manifest. Taken with no server running on
 * `home`. A file that is not a plain file fails it, and a snapshot that fails
 * is removed whole.
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
      yield* copyPrivate(source, path.join(folder, file)).pipe(Effect.mapError(failed(source)));
      files.push(file);
    }
    const manifest: SnapshotManifest = {
      takenAt,
      from: options.from,
      to: options.to,
      migration: yield* recordedHead(path.join(home, HOME_ENTRIES.database)),
      engineMigration: Option.getOrNull(
        yield* EngineLive.recordedMigration(path, path.join(home, HOME_ENTRIES.engine)),
      ),
      files,
    };
    const manifestFile = path.join(folder, MANIFEST);
    yield* Schema.encodeEffect(ManifestJson)(manifest).pipe(
      Effect.flatMap((text) => fs.writeFileString(manifestFile, text, { flag: "wx", mode: 0o600 })),
      Effect.andThen(fs.chmod(manifestFile, 0o600)),
      Effect.mapError(failed(manifestFile)),
    );
    return { folder, manifest } satisfies Snapshot;
  }).pipe(
    Effect.onError(() => fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/**
 * Puts the files of `snapshot` back in `home`, with no server running on it.
 * Every file a snapshot would copy that is in the home now is moved first
 * into `replaced-<time>` in the snapshot's folder, never deleted: a file the
 * snapshot does not have, such as a write-ahead log the release it replaces
 * left, must not stay beside the database put back. Each file is put back
 * whole, under a temporary name first.
 */
export const restoreSnapshot = Effect.fn("snapshot.restore")(function* (
  home: string,
  snapshot: Snapshot,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = (location: string) => (cause: unknown) =>
    new SnapshotFailed({ action: "restore", location, cause });
  const replaced = path.join(snapshot.folder, `replaced-${compact(yield* DateTime.now)}`);
  yield* fs.makeDirectory(replaced, { mode: 0o700 }).pipe(Effect.mapError(failed(replaced)));
  for (const file of snapshotFiles(path, home)) {
    const current = path.join(home, file);
    if (Option.isSome(yield* fs.lstat(current).pipe(Effect.option))) {
      const aside = path.join(replaced, file);
      yield* fs
        .makeDirectory(path.dirname(aside), { recursive: true, mode: 0o700 })
        .pipe(Effect.andThen(fs.rename(current, aside)), Effect.mapError(failed(current)));
    }
    if (!snapshot.manifest.files.includes(file)) continue;
    const restoring = `${current}.j3-restoring`;
    yield* fs
      .remove(restoring, { force: true })
      .pipe(
        Effect.andThen(copyPrivate(path.join(snapshot.folder, file), restoring)),
        Effect.andThen(fs.rename(restoring, current)),
        Effect.mapError(failed(current)),
      );
  }
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
    if (Option.isSome(manifest)) snapshots.push({ folder, manifest: manifest.value });
  }
  return snapshots.sort((a, b) => DateTime.Order(b.manifest.takenAt, a.manifest.takenAt));
});

/** Removes every snapshot in `home` but the newest `keep`. Anything else in `backups` stays. */
export const pruneSnapshots = Effect.fn("snapshot.prune")(function* (home: string, keep: number) {
  const fs = yield* FileSystem.FileSystem;
  const older = (yield* listSnapshots(home)).slice(keep);
  for (const { folder } of older) yield* fs.remove(folder, { recursive: true });
  return older;
});
