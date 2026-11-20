// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as AdminSocket from "./admin/AdminSocket.ts";
import * as ServerConfig from "./config.ts";
import * as Domain from "./domain.ts";
import * as Http from "./http.ts";
import * as Installation from "./installation.ts";
import { SYSTEM_PROMPT_FILE } from "./Layout.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Network from "./system/Network.ts";
import * as ToolEndpoint from "./tools/ToolEndpoint.ts";

const listen = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port, tls } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    let createServer = () => NodeHttp.createServer();
    if (Option.isSome(tls)) {
      const options = yield* Effect.all({
        cert: fs.readFileString(tls.value.certPath),
        key: fs.readFileString(tls.value.keyPath),
      });
      createServer = () => NodeHttps.createServer(options);
    }
    // On shutdown the server stops accepting connections and gives open
    // requests and sockets this long to finish.
    return NodeHttpServer.layer(createServer, {
      host,
      port,
      gracefulShutdownTimeout: "5 seconds",
    });
  }),
);

const logShutdown = Layer.effectDiscard(Effect.addFinalizer(() => Effect.logInfo("Shutting down")));

/**
 * The engine, run under `<J3_HOME>/engine`. Each harness starts this
 * package's `j3` bridge as the bot tools' MCP server, pointed at the tool
 * endpoint on loopback.
 *
 * No provider instance is configured yet: which harnesses to create, and
 * where their sign-ins live, is still to be decided, and until then the engine
 * offers no model and no bot can be created.
 */
const engine = Layer.unwrap(
  Effect.gen(function* () {
    // One server per home: a second one stops here, before it starts an engine.
    yield* AdminSocket.claim;
    const config = yield* ServerConfig.ServerConfig;
    const bridge = yield* Installation.bridgeEntryPoint;
    return EngineLive.layer({
      home: config.engineHome,
      port: config.enginePort,
      binaryOverride: config.engineBinary,
      providers: [],
      toolBridge: {
        command: process.execPath,
        args: [bridge, "--server", `http://127.0.0.1:${config.toolPort}`],
      },
      systemPromptFile: SYSTEM_PROMPT_FILE,
    });
  }),
);

/**
 * The whole server. Built in dependency order: configuration, the migrated
 * database, the engine and the domain, then the HTTP server, the tool
 * endpoint and the admin socket. Interrupting it (SIGINT, SIGTERM) releases
 * everything in reverse.
 */
export const layer = Layer.mergeAll(
  Http.layer,
  ToolEndpoint.layer,
  AdminSocket.layer,
  logShutdown,
).pipe(
  Layer.provide(listen),
  Layer.provide(Domain.layer),
  Layer.provide(engine),
  Layer.provide(Sqlite.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Network.layer)),
  Layer.provide(Logger.layer([Logger.consoleJson])),
);
