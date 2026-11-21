// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Engine } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Listener } from "../listener.ts";
import * as Ports from "../system/Ports.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import { WebClientStatus } from "../web/WebClient.ts";
import {
  ADMIN_PATHS,
  AdminStatus,
  PairingOffer,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
} from "./protocol.ts";

// The admin socket: how `j3-bots pair`, `j3-bots doctor` and
// `j3-bots provider connect` reach the running server. A Unix socket in the
// home, which only the operator's user can open, so it needs no credential.
// Nothing on the network reaches it. The server binds it only while it holds
// the home (`home/Home.ts`), which also removed any socket a stopped server
// left there.

/**
 * A code for a new device, or while pairing is locked, until when. The answer
 * is never logged: the request log records the method, path and status only.
 */
const offerPairing = Effect.gen(function* () {
  const devices = yield* Devices;
  const locked = yield* devices.lockedUntil;
  const offer: PairingOffer = Option.isSome(locked)
    ? { _tag: "locked", until: locked.value }
    : { _tag: "granted", ...(yield* devices.startPairing) };
  return yield* HttpServerResponse.schemaJson(PairingOffer)(offer).pipe(Effect.orDie);
});

const routes = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      const { toolPort, enginePort } = yield* ServerConfig;
      const listener = yield* Deferred.await(yield* Listener);
      const webClient = yield* WebClientStatus;
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
            webClient,
          };
          return yield* HttpServerResponse.schemaJson(AdminStatus)(status).pipe(Effect.orDie);
        }),
      );
    }),
  ),
  HttpRouter.add("POST", ADMIN_PATHS.pairing, offerPairing),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.unlockPairing,
    Effect.gen(function* () {
      yield* (yield* Devices).unlock;
      return yield* offerPairing;
    }),
  ),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.providerConnection,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.schemaBodyJson(ProviderConnectionRequest).pipe(
        Effect.option,
      );
      if (request._tag === "None") return HttpServerResponse.empty({ status: 400 });
      const { baseUrl, key, stopWork } = request.value;
      const runningWork = yield* RunningWork;
      const engine = yield* Engine;
      // No new work starts between the check and the restart: first sends
      // wait until the engine is back, or the connection was refused.
      const outcome = yield* (yield* SendPause).paused(
        Effect.gen(function* () {
          const working = stopWork ? [] : yield* runningWork.bots;
          return working.length > 0
            ? ({ _tag: "work-running", bots: working.length } satisfies ProviderConnectionOutcome)
            : yield* engine.connectProviders({ baseUrl, key: Redacted.make(key) });
        }),
      );
      return yield* HttpServerResponse.schemaJson(ProviderConnectionOutcome)(outcome).pipe(
        Effect.orDie,
      );
    }),
  ),
);

// Node removes the socket file when the server closes.
const listen = (adminSocket: string) =>
  Layer.mergeAll(
    Layer.effect(HttpServer.HttpServer)(
      Ports.makeServer(() => NodeHttp.createServer(), {
        path: adminSocket,
        gracefulShutdownTimeout: "1 second",
      }),
    ),
    NodeHttpServer.layerHttpServices,
  );

const served = Layer.unwrap(
  Effect.gen(function* () {
    const { adminSocket } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    // The private home (0700) is what keeps other users out; the socket's own
    // mode is defence in depth. It is set once the routes are served, because
    // anything that waits between the bind and the handler (`Ports.serve`)
    // would leave a request that arrived in between unanswered.
    return Ports.serve(routes, listen(adminSocket), { logAddress: false }).pipe(
      Layer.tap(() => fs.chmod(adminSocket, 0o600)),
    );
  }),
);

/**
 * The admin socket's routes, listening at `<home>/admin.sock`. Its server is
 * its own: the layer offers the rest of the server nothing.
 */
export const layer: Layer.Layer<
  never,
  Layer.Error<typeof served>,
  Layer.Services<typeof served>
> = served;
