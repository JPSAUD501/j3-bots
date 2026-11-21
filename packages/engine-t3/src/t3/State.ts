// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The engine's migration head is read from its database read-only, which only node:sqlite opens.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { engineFolders } from "./PrivateFiles.ts";

// What an update of J3 Bots copies of the engine's own state before it starts
// a release pinned to another engine, and puts back if that release never
// becomes ready. The engine's migrations go forward only: once a newer engine
// has opened its database, an older one refuses it (docs/architecture/engine.md).

/** The engine's database, in its `userdata` folder (**Read** at `db51b67`: `apps/server/src/config.ts:146-151`). */
const DATABASE = "statev2.sqlite";

/**
 * The engine's files an update copies, for an engine data directory at
 * `home`: its database, with the write-ahead log and its index beside it in
 * WAL mode, and its settings, which name the providers J3 Bots provisioned.
 * A file that does not exist is not copied.
 */
export const stateFiles = (path: Path.Path, home: string): ReadonlyArray<string> => {
  const { userdata } = engineFolders(path, home);
  return [
    ...["", "-wal", "-shm"].map((suffix) => path.join(userdata, `${DATABASE}${suffix}`)),
    path.join(userdata, "settings.json"),
  ];
};

/**
 * The highest migration the engine's database under `home` records, read
 * without writing to it: what an engine that opens it must know at least.
 * None when there is no database, or it cannot be read.
 */
export const recordedMigration = (path: Path.Path, home: string) =>
  Effect.sync(() => {
    const file = path.join(engineFolders(path, home).userdata, DATABASE);
    try {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        // A database with no migrations table fails here, and records none.
        const row = database
          .prepare("SELECT max(migration_id) AS head FROM effect_sql_migrations")
          .get();
        const head = row?.["head"];
        return typeof head === "number" ? Option.some(head) : Option.none<number>();
      } finally {
        database.close();
      }
    } catch {
      return Option.none<number>();
    }
  });
