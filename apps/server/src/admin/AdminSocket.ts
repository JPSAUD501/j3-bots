// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { PairResult } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../../package.json" with { type: "json" };
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { ServerConfig } from "../config.ts";
import { Devices } from "../devices/Devices.ts";
import * as Home from "../home/Home.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Listener } from "../listener.ts";
import * as Ports from "../system/Ports.ts";
import { ServerStop } from "../ServerStop.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import { WebClientStatus } from "../web/WebClient.ts";
import * as Pipe from "./pipe.ts";
import { hasAdminSocket } from "./socket.ts";
import {
  ADMIN_PATHS,
  AdminStatus,
  LocalDeviceRequest,
  PairingOffer,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
  RunningWorkReply,
} from "./protocol.ts";

// The admin channel: how `j3-bots pair`, `j3-bots doctor` and
// `j3-bots provider connect` reach the running server, and how the desktop app
// gets the device it uses and stops the server it runs. It needs no
// credential, because only the server's own user can reach it, two ways that
// serve the same routes:
//
// - the admin socket, a Unix socket in the home, which only that user can
//   open. The server binds it only while it holds the home (`home/Home.ts`),
//   which also removed any socket a stopped server left there;
// - with `--admin-fd`, a pipe inherited from the process that started the
//   server, which only that process holds (`pipe.ts`).
//
// Nothing on the network reaches either.

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
      const { toolPort, enginePort, publicOrigin } = yield* ServerConfig;
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
            ...Option.match(publicOrigin, {
              onNone: () => ({}),
              onSome: (origin) => ({ publicOrigin: origin }),
            }),
          };
          return yield* HttpServerResponse.schemaJson(AdminStatus)(status).pipe(Effect.orDie);
        }),
      );
    }),
  ),
  HttpRouter.add("POST", ADMIN_PATHS.pairing, offerPairing),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.localDevice,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.schemaBodyJson(LocalDeviceRequest).pipe(
        Effect.option,
      );
      if (request._tag === "None") return HttpServerResponse.empty({ status: 400 });
      const { name, replaces } = request.value;
      const mint = (yield* Devices).mint(name);
      // The answer holds the token, and the request log records only the
      // method, path and status.
      const paired =
        replaces === null ? yield* mint : yield* (yield* DeviceAuth).revokeWith(replaces, mint);
      yield* Effect.logInfo("Paired a device through the admin channel").pipe(
        Effect.annotateLogs({ deviceId: paired.deviceId, replaces }),
      );
      return yield* HttpServerResponse.schemaJson(PairResult)(paired).pipe(Effect.orDie);
    }),
  ),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.shutdown,
    Effect.gen(function* () {
      yield* Effect.logInfo("Stopping, as asked on the admin channel");
      // A stop releases the admin channels before the engine and the database,
      // and each answers the requests in progress, this one included, before it closes.
      yield* (yield* ServerStop).request;
      return HttpServerResponse.empty({ status: 202 });
    }),
  ),
  HttpRouter.add(
    "POST",
    ADMIN_PATHS.unlockPairing,
    Effect.gen(function* () {
      yield* (yield* Devices).unlock;
      return yield* offerPairing;
    }),
  ),
  HttpRouter.add(
    "GET",
    ADMIN_PATHS.runningWork,
    Effect.gen(function* () {
      const working = yield* (yield* RunningWork).bots;
      return yield* HttpServerResponse.schemaJson(RunningWorkReply)({ bots: working.length }).pipe(
        Effect.orDie,
      );
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

/** The umask a socket is bound under: no access for its group or other users. */
const OWNER_ONLY = 0o077;

/**
 * An HTTP server whose Unix socket only this user can connect to from the
 * moment it exists. The socket is created by the bind with the mode the umask
 * leaves, so the umask is narrowed for the call that binds: a mode set after
 * the bind would leave a moment in which the socket has the process's usual
 * one. Node binds a path inside `listen`, before it returns (`lib/net.js`,
 * `createServerHandle`, read on v24.x at 221ffa5), and no other JavaScript
 * runs during that call; the umask is the process's, so a file Node's thread pool creates in
 * that instant gets no access for group or others either.
 */
export class PrivateSocketServer extends NodeHttp.Server {
  override listen(...args: ReadonlyArray<unknown>): this {
    const umask = process.umask(OWNER_ONLY);
    try {
      Reflect.apply(super.listen, this, args);
    } finally {
      process.umask(umask);
    }
    return this;
  }
}

// Node removes the socket file when the server closes.
const listen = (adminSocket: string) =>
  Layer.mergeAll(
    Layer.effect(HttpServer.HttpServer)(
      Ports.makeServer(() => new PrivateSocketServer(), {
        path: adminSocket,
        gracefulShutdownTimeout: "1 second",
      }),
    ),
    NodeHttpServer.layerHttpServices,
  );

const served = Layer.unwrap(
  Effect.gen(function* () {
    const { home, adminSocket } = yield* ServerConfig;
    // Two things keep other users out: the private home (0700), and the
    // socket's own mode (`PrivateSocketServer`). The home is checked and
    // identified just before the bind, and again once the socket is served:
    // a home moved or replaced in between, which would have put the socket
    // somewhere else, stops the server. The check after is on the layer
    // `Ports.serve` returns, since anything that waits between the bind and
    // the handler would leave a request that arrived in between unanswered.
    const before = yield* Home.identifyPrivate(home);
    return Ports.serve(routes, listen(adminSocket), { logAddress: false }).pipe(
      Layer.tap(() => Home.checkUnchanged(home, before)),
    );
  }),
);

/**
 * The admin socket's routes, listening at `<home>/admin.sock`, on every
 * system that has one (`hasAdminSocket`). Its server is its own: the layer
 * offers the rest of the server nothing.
 */
export const layer: Layer.Layer<
  never,
  Layer.Error<typeof served>,
  Layer.Services<typeof served>
> = hasAdminSocket(process.platform) ? served : Layer.empty;

/**
 * The same routes, served on the pipe the server inherited at `fd` from the
 * process that started it (`pipe.ts`).
 */
export const pipeLayer = (fd: number) =>
  Ports.serve(routes, Pipe.server(fd), { logAddress: false });
