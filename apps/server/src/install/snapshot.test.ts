// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { listSnapshots, restoreSnapshot, takeSnapshot } from "./snapshot.ts";

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
      assert.strictEqual(taken.manifest.migration, 2);
      assert.isNull(taken.manifest.engineMigration);
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

      yield* restoreSnapshot(home, taken);
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
});
