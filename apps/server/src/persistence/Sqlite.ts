import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { runMigrations } from "./Migrations.ts";

// The client opens one connection in WAL mode with a busy timeout. Foreign keys
// are a per-connection setting in SQLite, so they are turned on here.
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations();
  }),
);

/** The database at `<J3_HOME>/j3.sqlite`, migrated before anything uses it. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { databasePath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
    return setup.pipe(Layer.provideMerge(SqliteClient.layer({ filename: databasePath })));
  }),
);
