// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Network from "../system/Network.ts";

/**
 * The server configuration of a test home: the database and the engine under
 * it, loopback only, every port chosen by the system.
 */
export const configFor = (path: Path.Path, home: string): ServerConfigShape => ({
  home,
  configFile: path.join(home, "config.json"),
  databasePath: path.join(home, "j3.sqlite"),
  engineHome: path.join(home, "engine"),
  host: "127.0.0.1",
  privateOnly: true,
  port: 0,
  tls: Option.none(),
  enginePort: 0,
  engineBinary: Option.none(),
  scriptedAgent: Option.none(),
  toolPort: 0,
  // No client is built there, so a test server serves none.
  webClient: { _tag: "bundled", directory: path.join(home, "web") },
  adminSocket: path.join(home, "admin.sock"),
  publicOrigin: Option.none(),
});

/**
 * The production database layer on a file `write` wrote first, if anything,
 * in the home `home` gives (foreign keys on, migrated), with the server
 * configuration that points at that home and the machine's own network
 * interfaces.
 */
const inHome = <E>(
  home: Effect.Effect<string, E, FileSystem.FileSystem | Scope.Scope>,
  write: (config: ServerConfigShape) => Effect.Effect<void, never, Path.Path>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = configFor(path, yield* home);
      yield* write(config);
      return Sqlite.layer.pipe(Layer.provideMerge(Layer.succeed(ServerConfig, config)));
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, Network.layer)));

/** `inHome` in a temporary home, removed with the layer. */
const inTemporaryHome = (
  write: (config: ServerConfigShape) => Effect.Effect<void, never, Path.Path>,
) =>
  inHome(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped()),
    write,
  );

/** The production database layer on a fresh file in a temporary home. */
export const layer = inTemporaryHome(() => Effect.void);

/**
 * The production database layer in `home`, which outlives it: a test that
 * starts a server there, stops it and works on what it left.
 */
export const layerAt = (home: string) => inHome(Effect.succeed(home), () => Effect.void);

/**
 * The production database layer on a file `write` wrote first, as an earlier
 * release of J3 Bots left it in the home `config` describes: the server
 * migrates it as it starts.
 */
export const layerAfter = <E>(
  write: (config: ServerConfigShape) => Effect.Effect<void, E, SqlClient.SqlClient | Path.Path>,
) =>
  inTemporaryHome((config) =>
    write(config).pipe(
      Effect.provide(SqliteClient.layer({ filename: config.databasePath })),
      Effect.orDie,
    ),
  );
