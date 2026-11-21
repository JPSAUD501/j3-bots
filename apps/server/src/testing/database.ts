// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
});

/**
 * The production database layer on a fresh file in a temporary home (foreign
 * keys on, migrated), with the server configuration that points at that home
 * and the machine's own network interfaces.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    return Sqlite.layer.pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, configFor(path, home))),
    );
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, Network.layer)));
