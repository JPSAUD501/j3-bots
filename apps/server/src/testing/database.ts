// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

/**
 * The production database layer on a fresh file in a temporary home (foreign
 * keys on, migrated), with the server configuration that points at that home.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    return Sqlite.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig, {
          home,
          databasePath: path.join(home, "j3.sqlite"),
          host: "127.0.0.1",
          port: 0,
          tls: Option.none(),
          enginePort: 0,
          engineBinary: Option.none(),
          toolPort: 0,
        }),
      ),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
