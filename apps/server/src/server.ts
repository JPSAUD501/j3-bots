// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ServerConfig from "./config.ts";
import * as Http from "./http.ts";
import * as Sqlite from "./persistence/Sqlite.ts";

const listen = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig.ServerConfig;
    // On shutdown the server stops accepting connections and gives open
    // requests and sockets this long to finish.
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host,
      port,
      gracefulShutdownTimeout: "5 seconds",
    });
  }),
);

const logShutdown = Layer.effectDiscard(Effect.addFinalizer(() => Effect.logInfo("Shutting down")));

/**
 * The whole server. Built in dependency order: configuration, the migrated
 * database, then the HTTP server. Interrupting it (SIGINT, SIGTERM) releases
 * everything in reverse.
 */
export const layer = Layer.mergeAll(Http.layer, logShutdown).pipe(
  Layer.provide(listen),
  Layer.provide(Sqlite.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(Logger.layer([Logger.consoleJson])),
);
