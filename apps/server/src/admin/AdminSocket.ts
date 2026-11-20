// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Listener } from "../listener.ts";
import * as Ports from "../system/Ports.ts";
import { isBuilt } from "../web/built.ts";
import { ADMIN_PATHS, AdminStatus, PairingGrant } from "./protocol.ts";

// The admin socket: how `j3-bots pair` and `j3-bots doctor` reach the running
// server. A Unix socket in the home, which only the operator's user can open,
// so it needs no credential. Nothing on the network reaches it. The server
// binds it only while it holds the home (`home/Home.ts`), which also removed
// any socket a stopped server left there.

const routes = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      const { webClient, toolPort, enginePort } = yield* ServerConfig;
      const listener = yield* Listener;
      const served = yield* isBuilt(webClient.directory);
      return HttpRouter.add(
        "GET",
        ADMIN_PATHS.status,
        Effect.gen(function* () {
          const engine = yield* EngineState;
          const devices = yield* Devices;
          const status: AdminStatus = {
            version: packageJson.version,
            pid: process.pid,
            startedAt,
            listener,
            toolPort,
            enginePort,
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
    return Layer.mergeAll(
      Layer.effect(HttpServer.HttpServer)(
        Ports.makeServer(() => NodeHttp.createServer(), {
          path: adminSocket,
          gracefulShutdownTimeout: "1 second",
        }),
      ),
      NodeHttpServer.layerHttpServices,
    ).pipe(Layer.tap(() => fs.chmod(adminSocket, 0o600)));
  }),
);

/** The admin socket's routes, listening at `<home>/admin.sock`. */
export const layer = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
  Layer.provide(listen),
);
