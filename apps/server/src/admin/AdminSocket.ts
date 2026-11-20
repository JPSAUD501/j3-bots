// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import { EngineState } from "../engine/EngineState.ts";
import { ADMIN_PATHS, AdminStatus, PairingGrant } from "./protocol.ts";
import * as Socket from "./socket.ts";

// The admin socket: how `j3-bots pair` and `j3-bots doctor` reach the running
// server. A Unix socket in the home, which only the operator's user can open,
// so it needs no credential. Nothing on the network reaches it.

/** Another server already answers on this home's admin socket. */
class ServerAlreadyRunning extends Schema.TaggedError<ServerAlreadyRunning>()(
  "ServerAlreadyRunning",
  { home: Schema.String },
) {
  override get message(): string {
    return `A J3 Bots server is already running for ${this.home}. Stop it before starting another.`;
  }
}

/**
 * Fails when a server already runs on this home, and removes a socket a
 * stopped server left behind. The server runs it before it starts the engine.
 */
export const claim = Effect.gen(function* () {
  const { home, adminSocket } = yield* ServerConfig;
  const state = yield* Socket.probe(adminSocket);
  if (state === "live") return yield* new ServerAlreadyRunning({ home });
  if (state === "stale") {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(adminSocket);
  }
});

const routes = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      const { webClient } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const served = yield* fs
        .exists(path.join(webClient.directory, "index.html"))
        .pipe(Effect.orElseSucceed(() => false));
      return HttpRouter.add(
        "GET",
        ADMIN_PATHS.status,
        Effect.gen(function* () {
          const engine = yield* EngineState;
          const devices = yield* Devices;
          const status: AdminStatus = {
            version: packageJson.version,
            startedAt,
            engine: yield* engine.current,
            pairedDevices: yield* devices.pairedCount,
            webClient: served ? "served" : "not-built",
          };
          return yield* HttpServerResponse.schemaJson(AdminStatus)(status).pipe(Effect.orDie);
        }),
      );
    }),
  ),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.pairing,
    Effect.gen(function* () {
      const devices = yield* Devices;
      const grant = yield* devices.startPairing;
      return yield* HttpServerResponse.schemaJson(PairingGrant)(grant).pipe(Effect.orDie);
    }),
  ),
);

const listen = Layer.unwrap(
  Effect.gen(function* () {
    const { adminSocket } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    // Node removes the socket file when the server closes.
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      path: adminSocket,
      gracefulShutdownTimeout: "1 second",
    }).pipe(Layer.tap(() => fs.chmod(adminSocket, 0o600)));
  }),
);

/** The admin socket's routes, listening at `<home>/admin.sock`. */
export const layer = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
  Layer.provide(listen),
);
