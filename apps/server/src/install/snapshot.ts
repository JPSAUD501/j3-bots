// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { flushFile, flushFolder } from "../files.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { isWithin } from "../paths.ts";

// What `j3-bots update` copies before it starts another release, and puts back
// if that release never becomes ready, or when the operator asks
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md):
//
//   <home>/backups/<taken>-<from>-to-<to>/
//     manifest.json                 what it is: SnapshotManifest
//     config.json  j3.sqlite[-wal|-shm]
//     engine/userdata/statev2.sqlite[-wal|-shm]  engine/userdata/settings.json
//     restoring                     while a rollback to it has not finished: RestoreMark
//     replaced-<time>-<random>/     what a rollback moved out of the home
//   <home>/backups/update.lock      held by the one update or rollback running
//
// Each file keeps its path relative to the home. Everything in it is this
// user's alone: folders 0700, files 0600. It is taken with no server on the
// home, so the databases and their logs agree, and flushed to the disk
// before its manifest is written: a folder without a manifest is not a
// snapshot, but a take that was cut off, which pruning removes. Bot files are
// not in it.

/** The manifest of a snapshot, in its folder. */
const MANIFEST = "manifest.json";

/** In a snapshot's folder from the start of a rollback to it until the release it ends on runs. */
const RESTORING = "restoring";

/** What a rollback names the copy of a snapshot's file it makes beside where it goes. */
const COPY_SUFFIX = ".j3-restoring";

/** The lock an update or a rollback holds, in `<home>/backups`, from start to end. */
export const UPDATE_LOCK = "update.lock";

/** A release, as a snapshot names it. */
export const SnapshotRelease = Schema.Struct({
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
  /** The files copied, by path relative to the home, `/` between its parts on every system. */
  files: Schema.Array(Schema.String),
});
type SnapshotManifest = typeof SnapshotManifest.Type;

const ManifestJson = Schema.fromJsonString(Schema.toCodecJson(SnapshotManifest));

/**
 * A rollback to a snapshot that has not finished, and how far it got:
 * `copying` the snapshot's files beside their place, which leaves the home as
 * it was; `swapping` them in, which leaves it holding part of the snapshot;
 * `restored`, which leaves it holding the snapshot, for `release` to start on.
 */
const RestoreMark = Schema.Struct({
  /** The release the rollback ends on: the snapshot's `from`. */
  release: Schema.String,
  stage: Schema.Literals(["copying", "swapping", "restored"]),
});
type RestoreMark = typeof RestoreMark.Type;

/**
 * How far a rollback that has not finished got, as its mark says: `unread`
 * when the mark cannot be read or does not decode, which a rollback carries
 * on from as from `copying`, copying everything again, but which says nothing
 * of what it already put back.
 */
export type RestoreState = RestoreMark | { readonly release: string; readonly stage: "unread" };

const RestoreMarkJson = Schema.fromJsonString(Schema.toCodecJson(RestoreMark));

export interface Snapshot {
  readonly folder: string;
  readonly manifest: SnapshotManifest;
  /**
   * A rollback to it that has not finished. Until it does, an update refuses
   * to start, pruning keeps the snapshot, and no server starts on the home
   * but `release` once the stage is `restored`.
   */
  readonly restoring: Option.Option<RestoreState>;
}

/**
 * What a rollback to `release` that has not finished keeps off the data
 * directory, as a clause: while the snapshot is not back `whole` every server
 * is refused there, and once it is, every release but `release`. A server
 * that runs already, as one does when a rollback is cut off right after its
 * mark, runs on until the rollback stops it.
 */
export const heldOff = (release: string, whole: boolean) =>
  whole
    ? `no server but J3 Bots ${release} starts on the data directory`
    : "no server starts on the data directory";

/** When a snapshot was taken, as the operator reads it: `2026-05-04 09:30:12 UTC`. */
export const takenAt = (snapshot: Snapshot) =>
  DateTime.formatIso(snapshot.manifest.takenAt)
    .replace(/\.\d+Z$/, " UTC")
    .replace("T", " ");

/** A snapshot could not be taken or put back. */
class SnapshotFailed extends Schema.TaggedError<SnapshotFailed>()("SnapshotFailed", {
  action: Schema.Literals(["take", "restore", "abandon"]),
  /** The file or folder it failed on. */
  location: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.action) {
      case "take":
        return `Copying ${this.location} into a snapshot failed, so the snapshot was not kept.`;
      case "restore":
        return `Putting ${this.location} back from the snapshot failed.`;
      case "abandon":
        return `Removing ${this.location}, a copy the rollback made from the snapshot, failed.`;
    }
  }
}

/**
 * The files a snapshot copies when they exist, by path relative to the home,
 * written with `/` on every system so that a manifest reads the same
 * everywhere: the configuration, J3 Bots' database with its write-ahead log,
 * and the engine's own state (`stateFiles`).
 */
const snapshotFiles = (path: Path.Path, home: string): ReadonlyArray<string> => [
  HOME_ENTRIES.config,
  HOME_ENTRIES.database,
  HOME_ENTRIES.databaseLog,
  HOME_ENTRIES.databaseLogIndex,
  ...EngineLive.stateFiles(path, path.join(home, HOME_ENTRIES.engine)).map((file) =>
    path.relative(home, file).split(path.sep).join("/"),
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
const snapshotBytes = Effect.fn("snapshot.bytes")(function* (home: string) {
  return yield* bytesOf(home, snapshotFiles(yield* Path.Path, home));
});

/** Free space a change to the data directory keeps beyond the copies it makes there. */
export const HOME_ROOM = 1024 ** 3;

/**
 * The free space a transition needs where `home` is: the snapshot it takes,
 * the copies a rollback would put back, and `HOME_ROOM`.
 */
export const transitionRoom = Effect.fn("snapshot.transitionRoom")(function* (home: string) {
  return 2 * (yield* snapshotBytes(home)) + HOME_ROOM;
});

/** A folder of the home's whose files a restore moves aside, on another filesystem than `backups/`. */
export interface BackupsElsewhere {
  /** The folder of the home's. */
  readonly folder: string;
  /** `<home>/backups`. */
  readonly backups: string;
  /** The folder `backups` is a link to, when it is one. */
  readonly linkTo: Option.Option<string>;
}

/**
 * The first folder of `home` that holds files a restore moves aside and is on
 * another filesystem than `<home>/backups`, if one is. A restore moves them
 * into the snapshot's folder by renaming them, which never crosses
 * filesystems: it would stop with the service disabled, every time it ran.
 */
export const backupsElsewhere = Effect.fn("snapshot.backupsElsewhere")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const backups = path.join(home, HOME_ENTRIES.backups);
  const target = yield* fs.stat(backups).pipe(Effect.option);
  if (Option.isNone(target)) return Option.none<BackupsElsewhere>();
  const folders = new Set([
    home,
    ...snapshotFiles(path, home).map((file) => path.dirname(path.join(home, file))),
  ]);
  for (const folder of folders) {
    const info = yield* fs.stat(folder).pipe(Effect.option);
    if (Option.isSome(info) && info.value.dev !== target.value.dev) {
      const link = yield* fs.lstat(backups).pipe(Effect.option);
      const linkTo = Option.exists(link, ({ type }) => type === "SymbolicLink")
        ? yield* fs.realPath(backups).pipe(Effect.option)
        : Option.none<string>();
      return Option.some<BackupsElsewhere>({ folder, backups, linkTo });
    }
  }
  return Option.none<BackupsElsewhere>();
});

/**
 * Why a rollback could not use `<home>/backups` when it is `elsewhere`: it
 * moves the home's files into it, which never crosses filesystems.
 */
export const backupsElsewhereReason = ({ folder, backups, linkTo }: BackupsElsewhere): string =>
  `${Option.match(linkTo, {
    onSome: (target) => `${backups} is a link to ${target}, on another filesystem than ${folder}`,
    onNone: () => `${backups} is on another filesystem than ${folder}`,
  })}. A rollback moves the data directory's files into it, which cannot cross filesystems, so backups must be on the data directory's filesystem.`;

/** `<home>/backups` is on another filesystem than files a rollback would move into it. */
class BackupsNotBeside extends Schema.TaggedError<BackupsNotBeside>()("BackupsNotBeside", {
  folder: Schema.String,
  backups: Schema.String,
  linkTo: Schema.Option(Schema.String),
}) {
  override get message(): string {
    return `${backupsElsewhereReason(this)} Nothing was changed.`;
  }
}

/** Fails when a rollback in `home` could not move its files into `backups/`. */
export const requireBackupsBeside = Effect.fn("snapshot.requireBackupsBeside")(function* (
  home: string,
) {
  const elsewhere = yield* backupsElsewhere(home);
  if (Option.isSome(elsewhere)) return yield* new BackupsNotBeside(elsewhere.value);
});

/**
 * How many more bytes a rollback to `snapshot` copies into `home`: none once
 * its copies are made, and otherwise the snapshot's files less the copies a
 * cut-off rollback left, which it removes first.
 */
export const restoreBytes = Effect.fn("snapshot.restoreBytes")(function* (
  home: string,
  snapshot: Snapshot,
) {
  if (Option.exists(snapshot.restoring, ({ stage }) => stage !== "copying")) return 0;
  const files = snapshot.manifest.files;
  const left = yield* bytesOf(
    home,
    files.map((file) => `${file}${COPY_SUFFIX}`),
  );
  return Math.max(0, (yield* bytesOf(snapshot.folder, files)) - left);
});

/** Each folder from the folder of each of `files` up to `root`, `root` included. */
const foldersUpTo = (path: Path.Path, root: string, files: ReadonlyArray<string>) => {
  const folders = new Set<string>([root]);
  for (const file of files) {
    for (let folder = path.dirname(file); folder !== root && isWithin(root, folder);) {
      folders.add(folder);
      folder = path.dirname(folder);
    }
  }
  return [...folders];
};

/** The name `takeSnapshot` gives a snapshot's folder: `<taken>-<from>-to-<to>`. */
const SNAPSHOT_NAME = /^\d{8}T\d{6}Z-.+-to-.+$/;

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
        Effect.andThen(flushFile(copy)),
        Effect.mapError(failed(source)),
      );
      files.push(file);
    }
    const manifest: SnapshotManifest = { takenAt, from: options.from, to: options.to, files };
    const manifestFile = path.join(folder, MANIFEST);
    yield* Schema.encodeEffect(ManifestJson)(manifest).pipe(
      Effect.flatMap((text) => fs.writeFileString(manifestFile, text, { flag: "wx", mode: 0o600 })),
      Effect.andThen(fs.chmod(manifestFile, 0o600)),
      Effect.andThen(flushFile(manifestFile)),
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
          flushFolder,
          { discard: true },
        ),
      ),
      Effect.mapError(failed(manifestFile)),
    );
    return { folder, manifest, restoring: Option.none() } satisfies Snapshot;
  }).pipe(
    Effect.onError(() => fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/** The mark of a rollback to the snapshot in `folder`, as listed with `manifest`. */
const readMark = Effect.fnUntraced(function* (folder: string, manifest: SnapshotManifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(folder, RESTORING);
  const unread: RestoreState = { release: manifest.from.version, stage: "unread" };
  if (!(yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true)))) {
    return Option.none<RestoreState>();
  }
  return Option.some(
    yield* fs.readFileString(marker).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RestoreMarkJson)),
      Effect.orElseSucceed((): RestoreState => unread),
    ),
  );
});

/** A rollback could not be marked as started, moved on, or finished. */
class MarkFailed extends Schema.TaggedError<MarkFailed>()("MarkFailed", {
  marker: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Writing ${this.marker}, which records how far the rollback got, failed.`;
  }
}

/** Replaces the mark in `folder` whole with `mark`, flushed: a cut leaves the one before or this one. */
const writeMark = Effect.fnUntraced(function* (folder: string, mark: RestoreMark) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(folder, RESTORING);
  const next = `${marker}.next`;
  yield* Schema.encodeEffect(RestoreMarkJson)(mark).pipe(
    Effect.flatMap((text) => fs.writeFileString(next, text, { mode: 0o600 })),
    Effect.andThen(flushFile(next)),
    Effect.andThen(fs.rename(next, marker)),
    Effect.andThen(flushFolder(folder)),
    Effect.mapError((cause) => new MarkFailed({ marker, cause })),
  );
});

/**
 * Marks a rollback to `snapshot` as started, before it stops or changes
 * anything: `copying`, ending on the release the snapshot was taken from. A
 * mark a rollback cut off left is kept as it is, so the next one carries on
 * from where it got.
 */
export const markRestoring = Effect.fn("snapshot.markRestoring")(function* (snapshot: Snapshot) {
  if (Option.isSome(yield* readMark(snapshot.folder, snapshot.manifest))) return;
  yield* writeMark(snapshot.folder, {
    release: snapshot.manifest.from.version,
    stage: "copying",
  });
});

/** Marks a rollback to `snapshot` as finished, once its release runs: removes the mark. */
export const unmarkRestoring = Effect.fn("snapshot.unmarkRestoring")(function* (
  snapshot: Snapshot,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(snapshot.folder, RESTORING);
  yield* fs.remove(marker, { force: true }).pipe(
    Effect.andThen(flushFolder(snapshot.folder)),
    Effect.mapError((cause) => new MarkFailed({ marker, cause })),
  );
});

/**
 * Gives up a rollback to `snapshot` that has put nothing back yet, its mark
 * at `copying`: removes the copies a cut-off copying left beside their place,
 * then the mark. The home is as the rollback found it. The snapshot stays.
 */
export const abandonRestore = Effect.fn("snapshot.abandonRestore")(function* (
  home: string,
  snapshot: Snapshot,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of snapshot.manifest.files) {
    const copy = `${path.join(home, file)}${COPY_SUFFIX}`;
    yield* fs
      .remove(copy, { force: true })
      .pipe(
        Effect.mapError(
          (cause) => new SnapshotFailed({ action: "abandon", location: copy, cause }),
        ),
      );
  }
  yield* unmarkRestoring(snapshot);
});

/**
 * Puts the files of `snapshot` back in `home`, marked first (`markRestoring`),
 * with no server on it, in an order a cut at any point leaves a mark that
 * says how far it got, and from which this carries on:
 *
 * 1. `copying`: every file of the snapshot is copied beside where it goes,
 *    under a temporary name, and flushed. The home is as it was.
 * 2. `swapping`: every file a snapshot would copy that is in the home, but not
 *    one of the snapshot's already put in place, is moved into `replaced-*`
 *    in the snapshot's folder, never deleted: a file the snapshot does not
 *    have, such as a write-ahead log the release it replaces left, must not
 *    stay beside the database put back. Then the copies are renamed into
 *    place and the folders flushed.
 * 3. `restored`: the home holds the snapshot. The mark stays until the
 *    release it ends on runs (`unmarkRestoring`).
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
    Effect.forEach(folders, (folder) => flushFolder(folder).pipe(Effect.mapError(failed(folder))), {
      discard: true,
    });
  const mark = Option.getOrElse(
    yield* readMark(snapshot.folder, snapshot.manifest),
    (): RestoreState => ({ release: snapshot.manifest.from.version, stage: "copying" }),
  );
  const placed = snapshot.manifest.files.map((file) => ({
    file,
    source: path.join(snapshot.folder, file),
    copy: `${path.join(home, file)}${COPY_SUFFIX}`,
    current: path.join(home, file),
  }));
  const homeFolders = foldersUpTo(
    path,
    home,
    placed.map(({ current }) => current),
  );

  // A mark that cannot be read is carried on from the start: copying again
  // is the safe side, and the swap passes over what is already in place.
  if (mark.stage === "copying" || mark.stage === "unread") {
    yield* Effect.forEach(
      placed,
      ({ source, copy, current }) =>
        fs
          .remove(copy, { force: true })
          .pipe(
            Effect.andThen(copyPrivate(source, copy)),
            Effect.andThen(flushFile(copy)),
            Effect.mapError(failed(current)),
          ),
      { discard: true },
    ).pipe(
      // Only space: the home is as it was, and the next rollback copies again.
      Effect.onError(() =>
        Effect.forEach(placed, ({ copy }) => fs.remove(copy, { force: true }), {
          discard: true,
        }).pipe(Effect.ignore),
      ),
    );
    yield* flushAll(homeFolders);
    yield* writeMark(snapshot.folder, { release: mark.release, stage: "swapping" });
  }

  if (mark.stage !== "restored") {
    // A file whose copy is gone was put in place by a swap that was cut off.
    const waiting: Array<(typeof placed)[number]> = [];
    const inPlace = new Set<string>();
    for (const entry of placed) {
      if (yield* fs.exists(entry.copy).pipe(Effect.mapError(failed(entry.copy)))) {
        waiting.push(entry);
      } else {
        inPlace.add(entry.file);
      }
    }
    const leaving: Array<string> = [];
    for (const file of snapshotFiles(path, home)) {
      if (inPlace.has(file)) continue;
      if (Option.isSome(yield* fs.lstat(path.join(home, file)).pipe(Effect.option))) {
        leaving.push(file);
      }
    }
    if (leaving.length > 0) {
      const replaced = yield* fs
        .makeTempDirectory({
          directory: snapshot.folder,
          prefix: `replaced-${compact(yield* DateTime.now)}-`,
        })
        .pipe(Effect.mapError(failed(snapshot.folder)));
      const asides = leaving.map((file) => path.join(replaced, file));
      for (const file of leaving) {
        const current = path.join(home, file);
        const aside = path.join(replaced, file);
        yield* fs
          .makeDirectory(path.dirname(aside), { recursive: true, mode: 0o700 })
          .pipe(Effect.andThen(fs.rename(current, aside)), Effect.mapError(failed(current)));
      }
      yield* flushAll(
        new Set([
          ...foldersUpTo(
            path,
            home,
            leaving.map((file) => path.join(home, file)),
          ),
          ...foldersUpTo(path, snapshot.folder, asides),
        ]),
      );
    }
    for (const { copy, current } of waiting) {
      yield* fs.rename(copy, current).pipe(Effect.mapError(failed(current)));
    }
    yield* flushAll(homeFolders);
    yield* writeMark(snapshot.folder, { release: mark.release, stage: "restored" });
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
    if (Option.isNone(manifest)) continue;
    const restoring = yield* readMark(folder, manifest.value);
    snapshots.push({ folder, manifest: manifest.value, restoring });
  }
  return snapshots.sort((a, b) => DateTime.Order(b.manifest.takenAt, a.manifest.takenAt));
});

/** The snapshot a rollback to has not finished in `home`, with its mark, if one has not. */
export const unfinishedRollback = Effect.fn("snapshot.unfinishedRollback")(function* (
  home: string,
) {
  for (const snapshot of yield* listSnapshots(home)) {
    if (Option.isSome(snapshot.restoring)) {
      return Option.some({ snapshot, mark: snapshot.restoring.value });
    }
  }
  return Option.none<{ readonly snapshot: Snapshot; readonly mark: RestoreState }>();
});

/**
 * The snapshot `--rollback` puts back in `home` while `running` runs: the one
 * a rollback to has not finished, if there is one; otherwise the newest taken
 * by an update to `running`. An update that failed and rolled itself back
 * took a newer one, to a release that does not run, which this passes over.
 * `None` when there is none.
 */
export const rollbackSnapshot = Effect.fn("snapshot.rollbackSnapshot")(function* (
  home: string,
  running: string,
) {
  const snapshots = yield* listSnapshots(home);
  return Option.fromNullishOr(
    snapshots.find(({ restoring }) => Option.isSome(restoring)) ??
      snapshots.find(({ manifest }) => manifest.to.version === running),
  );
});

/**
 * The folders in `home`'s backups that a take of a snapshot cut off left: a
 * folder named as a snapshot, not a link, holding nothing a take does not
 * write, so no mark and no `replaced-*` of a rollback, whose manifest is
 * missing or is not JSON at all, as a cut while it was written leaves it. A
 * manifest that is JSON but does not decode, as a newer release's may not,
 * and one that cannot be read, are not taken for a cut.
 */
const cutOffTakes = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const backups = path.join(home, HOME_ENTRIES.backups);
  // What a take writes in its folder: the snapshot's files, by their first folder, and the manifest.
  const written = new Set([
    MANIFEST,
    ...snapshotFiles(path, home).map((file) => file.split("/")[0] ?? file),
  ]);
  const found: Array<string> = [];
  for (const name of yield* fs.readDirectory(backups).pipe(Effect.orElseSucceed(() => []))) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    const folder = path.join(backups, name);
    const info = yield* fs.lstat(folder).pipe(Effect.option);
    if (!Option.exists(info, ({ type }) => type === "Directory")) continue;
    const entries = yield* fs.readDirectory(folder).pipe(Effect.option);
    if (!Option.exists(entries, (names) => names.every((entry) => written.has(entry)))) continue;
    const manifest = yield* Effect.result(fs.readFileString(path.join(folder, MANIFEST)));
    const cut =
      manifest._tag === "Failure"
        ? manifest.failure.reason._tag === "NotFound"
        : Option.isNone(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              manifest.success,
            ).pipe(Effect.option),
          );
    if (cut) found.push(folder);
  }
  return found;
});

/**
 * Removes every snapshot in `home` but the newest `keep`, each with what its
 * rollbacks replaced, in its `replaced-*` folders, and every take of one that
 * was cut off before its manifest (`cutOffTakes`). A snapshot a rollback to
 * has not finished is kept. Anything else in `backups` stays. Run under the
 * update lock, which every take holds, so no take is under way.
 */
export const pruneSnapshots = Effect.fn("snapshot.prune")(function* (home: string, keep: number) {
  const fs = yield* FileSystem.FileSystem;
  const older = (yield* listSnapshots(home))
    .slice(keep)
    .filter(({ restoring }) => Option.isNone(restoring));
  for (const { folder } of older) yield* fs.remove(folder, { recursive: true });
  for (const folder of yield* cutOffTakes(home)) yield* fs.remove(folder, { recursive: true });
  return older;
});
