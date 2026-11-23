// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { devicesApart } from "../testing/filesystem.ts";
import {
  backupsElsewhere,
  listSnapshots,
  markRestoring,
  pruneSnapshots,
  restoreBytes,
  restoreSnapshot,
  rollbackSnapshot,
  type Snapshot,
  takeSnapshot,
  unmarkRestoring,
} from "./snapshot.ts";

/** Every file and folder under `folder`, by path relative to it, with its permission bits. */
const modesUnder = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modes = new Map<string, number>();
    for (const entry of yield* fs.readDirectory(folder, { recursive: true })) {
      modes.set(entry, (yield* fs.stat(path.join(folder, entry))).mode & 0o777);
    }
    return modes;
  });

/** Writes `files`, by path relative to `home`, with their text. */
const writeAll = (home: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(home, file)), { recursive: true });
      yield* fs.writeFileString(path.join(home, file), text);
    }
  });

/** The text of each of `files` in `folder`, or none where it is missing. */
const readAll = (folder: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const texts: Record<string, string | null> = {};
    for (const file of files) {
      const at = path.join(folder, file);
      texts[file] = (yield* fs.exists(at)) ? yield* fs.readFileString(at) : null;
    }
    return texts;
  });

/** A file system whose renames onto `failing` fail, as a full or failing disk would. */
const renamesFailingOnto = (fs: FileSystem.FileSystem, failing: string) =>
  FileSystem.FileSystem.of({
    ...fs,
    rename: (from, to) =>
      to === failing
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "rename",
              pathOrDescriptor: to,
              cause: Object.assign(new Error(`EIO: i/o error, rename '${to}'`), { code: "EIO" }),
            }),
          )
        : fs.rename(from, to),
  });

const FILES = ["config.json", "j3.sqlite", "engine/userdata/settings.json"] as const;

/** How far the rollback to the newest snapshot in `home` got, or none when it is not marked. */
const stageIn = (home: string) =>
  listSnapshots(home).pipe(
    Effect.map(([newest]) =>
      newest === undefined ? undefined : Option.getOrUndefined(newest.restoring)?.stage,
    ),
  );

/** The copies a rollback left beside the files of `home`. */
const copiesIn = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(home, { recursive: true }))
      .filter((entry) => entry.endsWith(".j3-restoring"))
      .sort();
  });

/** Marks, puts back and unmarks `snapshot`, as a rollback that is not cut off does. */
const rollBack = (home: string, snapshot: Snapshot) =>
  markRestoring(snapshot).pipe(
    Effect.andThen(restoreSnapshot(home, snapshot)),
    Effect.andThen(unmarkRestoring(snapshot)),
  );

it.layer(NodeServices.layer)("a snapshot", (it) => {
  it.effect("copies the databases and settings privately, and puts them back whole", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const at = (file: string) => path.join(home, file);

      // A home as a stopped server left it: J3 Bots' database with two
      // migrations, the engine's database and settings, the configuration,
      // all readable by others, and a bot's file the snapshot leaves alone.
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "1_fixture": Effect.void, "2_fixture": Effect.void }),
      }).pipe(Effect.provide(SqliteClient.layer({ filename: at("j3.sqlite") })));
      yield* fs.makeDirectory(at("engine/userdata"), { recursive: true });
      yield* fs.makeDirectory(at("bots/scout/memory"), { recursive: true });
      for (const [file, text] of [
        ["config.json", '{"port":3737}'],
        ["engine/userdata/statev2.sqlite", "the engine's database"],
        ["engine/userdata/settings.json", '{"providers":[]}'],
        ["bots/scout/memory/profile.md", "Scout, before"],
      ] as const) {
        yield* fs.writeFileString(at(file), text, { mode: 0o644 });
        yield* fs.chmod(at(file), 0o644);
      }
      const database = yield* fs.readFile(at("j3.sqlite"));

      const taken = yield* takeSnapshot({
        home,
        from: { version: "0.1.0", engine: "0.1.11" },
        to: { version: "0.2.0" },
      });
      assert.deepStrictEqual(yield* listSnapshots(home), [taken]);
      assert.deepStrictEqual(taken.manifest.files, [
        "config.json",
        "j3.sqlite",
        "engine/userdata/statev2.sqlite",
        "engine/userdata/settings.json",
      ]);
      const modes = yield* modesUnder(taken.folder);
      for (const [entry, mode] of modes) {
        const folder = (yield* fs.stat(path.join(taken.folder, entry))).type === "Directory";
        assert.strictEqual(mode, folder ? 0o700 : 0o600, entry);
      }
      assert.isTrue(modes.has("manifest.json"));
      assert.strictEqual((yield* fs.stat(path.dirname(taken.folder))).mode & 0o777, 0o700);

      // What the new release did: it changed the configuration and the
      // engine's settings, left a write-ahead log the snapshot does not have,
      // and a bot wrote its memory.
      yield* fs.writeFileString(at("config.json"), '{"port":4747}');
      yield* fs.writeFileString(at("engine/userdata/settings.json"), '{"providers":["new"]}');
      yield* fs.writeFileString(at("j3.sqlite-wal"), "a newer release's log");
      yield* fs.writeFileString(at("bots/scout/memory/profile.md"), "Scout, after");

      yield* rollBack(home, taken);
      assert.isUndefined(yield* stageIn(home));
      assert.strictEqual(yield* fs.readFileString(at("config.json")), '{"port":3737}');
      assert.strictEqual(
        yield* fs.readFileString(at("engine/userdata/settings.json")),
        '{"providers":[]}',
      );
      assert.deepStrictEqual(yield* fs.readFile(at("j3.sqlite")), database);
      assert.isFalse(yield* fs.exists(at("j3.sqlite-wal")));
      assert.strictEqual((yield* fs.stat(at("config.json"))).mode & 0o777, 0o600);
      // Bot files are not in a snapshot: what the bot wrote stays.
      assert.strictEqual(
        yield* fs.readFileString(at("bots/scout/memory/profile.md")),
        "Scout, after",
      );

      // Nothing the restore replaced is lost: it is kept beside the snapshot.
      const [replaced] = (yield* fs.readDirectory(taken.folder)).filter((entry) =>
        entry.startsWith("replaced-"),
      );
      assert.isDefined(replaced);
      const aside = path.join(taken.folder, replaced ?? "");
      assert.strictEqual(
        yield* fs.readFileString(path.join(aside, "config.json")),
        '{"port":4747}',
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(aside, "j3.sqlite-wal")),
        "a newer release's log",
      );
    }),
  );

  it.effect(
    "that cannot be copied back leaves the home as it was, its rollback still to copy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        yield* writeAll(home, { "config.json": "before", "j3.sqlite": "before" });
        const taken = yield* takeSnapshot({
          home,
          from: { version: "0.1.0" },
          to: { version: "0.2.0" },
        });
        yield* writeAll(home, { "config.json": "after", "j3.sqlite": "after" });
        // A file of the snapshot that is gone: copying it back fails.
        yield* fs.remove(path.join(taken.folder, "j3.sqlite"));

        yield* markRestoring(taken);
        assert.strictEqual((yield* Effect.exit(restoreSnapshot(home, taken)))._tag, "Failure");
        assert.deepStrictEqual(yield* readAll(home, ["config.json", "j3.sqlite"]), {
          "config.json": "after",
          "j3.sqlite": "after",
        });
        assert.deepStrictEqual(yield* copiesIn(home), []);
        // Still marked: only `--rollback` may change the home until it finishes.
        assert.strictEqual(yield* stageIn(home), "copying");
      }),
  );

  it.effect(
    "cut off once it changed the home is kept marked, and a restore again finishes it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const before = {
          "config.json": "before",
          "j3.sqlite": "before",
          "engine/userdata/settings.json": "before",
        };
        yield* writeAll(home, before);
        const taken = yield* takeSnapshot({
          home,
          from: { version: "0.1.0" },
          to: { version: "0.2.0" },
        });
        yield* writeAll(home, {
          "config.json": "after",
          "j3.sqlite": "after",
          "j3.sqlite-wal": "after",
          "engine/userdata/settings.json": "after",
        });

        // The live files are moved aside, then putting the database back fails.
        yield* markRestoring(taken);
        const cut = yield* Effect.exit(
          restoreSnapshot(home, taken).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              renamesFailingOnto(fs, path.join(home, "j3.sqlite")),
            ),
          ),
        );
        assert.strictEqual(cut._tag, "Failure");
        assert.strictEqual(yield* stageIn(home), "swapping");
        // Marking it again, as the next rollback does, keeps how far it got.
        yield* markRestoring(taken);
        assert.strictEqual(yield* stageIn(home), "swapping");
        // Its copies are made: none is left to count against free space.
        const [marked] = yield* listSnapshots(home);
        assert.strictEqual(marked && (yield* restoreBytes(home, marked)), 0);
        // Pruning keeps it, with what the restore moved aside.
        assert.deepStrictEqual(yield* pruneSnapshots(home, 0), []);
        // And it is the one `--rollback` puts back, whatever runs.
        const chosen = yield* rollbackSnapshot(home, "0.9.0");
        assert.strictEqual(Option.getOrUndefined(chosen)?.folder, taken.folder);

        // The next restore uses the copies it made, not the snapshot's files.
        yield* fs.remove(path.join(taken.folder, "j3.sqlite"));
        yield* restoreSnapshot(home, taken);
        assert.deepStrictEqual(yield* readAll(home, FILES), before);
        assert.isFalse(yield* fs.exists(path.join(home, "j3.sqlite-wal")));
        assert.deepStrictEqual(yield* copiesIn(home), []);
        // Back whole, and marked until the release it ends on runs.
        assert.strictEqual(yield* stageIn(home), "restored");
        yield* unmarkRestoring(taken);
        assert.isUndefined(yield* stageIn(home));
        // Nothing the home held is lost: what the restore moved out is kept.
        const replaced = (yield* fs.readDirectory(taken.folder)).filter((entry) =>
          entry.startsWith("replaced-"),
        );
        assert.strictEqual(replaced.length, 1);
        const kept = yield* readAll(path.join(taken.folder, replaced[0] ?? ""), [
          ...FILES,
          "j3.sqlite-wal",
        ]);
        assert.strictEqual(Object.values(kept).filter((text) => text === "after").length, 4);
      }),
  );

  it.effect("to copy back counts only what is left to copy against free space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* writeAll(home, { "config.json": "12345", "j3.sqlite": "1234567890" });
      const taken = yield* takeSnapshot({ home, from: { version: "A" }, to: { version: "B" } });
      assert.strictEqual(yield* restoreBytes(home, taken), 15);
      // A rollback cut off while copying left the database's copy.
      yield* markRestoring(taken);
      yield* fs.writeFileString(path.join(home, "j3.sqlite.j3-restoring"), "1234567890");
      const [marked] = yield* listSnapshots(home);
      assert.strictEqual(marked && (yield* restoreBytes(home, marked)), 5);
    }),
  );

  it.effect("for a rollback is the newest taken by an update to the release that runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* writeAll(home, { "config.json": "a" });
      // A to B succeeded; B to C failed and rolled itself back, so B runs.
      const toB = yield* takeSnapshot({ home, from: { version: "A" }, to: { version: "B" } });
      yield* TestClock.adjust("1 second");
      yield* takeSnapshot({ home, from: { version: "B" }, to: { version: "C" } });

      const chosen = yield* rollbackSnapshot(home, "B");
      assert.strictEqual(Option.getOrUndefined(chosen)?.folder, toB.folder);
      assert.isTrue(Option.isNone(yield* rollbackSnapshot(home, "D")));
    }),
  );

  it.effect("finds the data a restore moves aside on another filesystem than backups", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const disk = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* writeAll(home, { "config.json": "a", "engine/userdata/settings.json": "{}" });
      const backups = path.join(home, "backups");
      const elsewhere = (apart: ReadonlyArray<string>) =>
        backupsElsewhere(home).pipe(
          Effect.provideService(FileSystem.FileSystem, devicesApart(fs, apart)),
        );

      // No update made it yet, then one beside the data.
      assert.isTrue(Option.isNone(yield* elsewhere([disk])));
      yield* fs.makeDirectory(backups);
      assert.isTrue(Option.isNone(yield* elsewhere([disk])));

      // The engine's state on a disk of its own.
      const userdata = path.join(home, "engine", "userdata");
      assert.deepStrictEqual(
        yield* elsewhere([userdata]),
        Option.some({
          folder: userdata,
          backups,
          linkTo: Option.none(),
        }),
      );

      // backups a link to a folder on another disk.
      yield* fs.remove(backups, { recursive: true });
      yield* fs.symlink(disk, backups);
      assert.deepStrictEqual(
        yield* elsewhere([disk]),
        Option.some({
          folder: home,
          backups,
          linkTo: Option.some(disk),
        }),
      );
    }).pipe(Effect.scoped),
  );
});
