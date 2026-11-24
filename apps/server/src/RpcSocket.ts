// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS, NotAuthenticated } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { CurrentDevice, DeviceAuth, type SocketCredential } from "./auth/DeviceAuth.ts";

/** What a client sees of a request that failed unexpectedly. The cause is logged instead. */
export const INTERNAL_ERROR = "Internal server error";

/** The credential an upgrade carries: the device token as a bearer, or a one-use ticket. */
export const credentialOf = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<SocketCredential> => {
  const authorization = request.headers["authorization"];
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    return Option.some({ _tag: "bearer", token: authorization.slice("Bearer ".length) });
  }
  const ticket = new URL(request.url, "http://localhost").searchParams.get("ticket");
  return ticket === null ? Option.none() : Option.some({ _tag: "ticket", ticket });
};

// A defect fails its own request with a fixed message and nothing else: the
// socket and every other request on it carry on. This runs as middleware,
// around the handler alone, so the defect is replaced before any reply is
// written. Clients never see it: it is not part of the contract.
class DefectGuard extends RpcMiddleware.Service<DefectGuard>()(
  "@j3-bots/server/RpcSocket/DefectGuard",
) {}

const defectGuard = Layer.succeed(DefectGuard)((effect, { rpc }) =>
  Effect.catchDefect(effect, (defect) =>
    Effect.logError(`The ${rpc._tag} handler failed`, Cause.die(defect)).pipe(
      Effect.andThen(Effect.die(INTERNAL_ERROR)),
    ),
  ),
);

const refuse = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

/**
 * The RPC socket at `HTTP_PATHS.rpc`. The upgrade is authenticated once, with
 * the device token as a bearer or with a single-use ticket; an upgrade without
 * one is answered 401 and never becomes a socket. Each socket gets its own RPC
 * server, built with `handlers`, which can read `CurrentDevice`. Revoking the
 * device closes the socket at once.
 */
export const layer = <Rpcs extends Rpc.Any, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs>, never, R | CurrentDevice>,
) =>
  HttpRouter.add(
    "GET",
    HTTP_PATHS.rpc,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* DeviceAuth;
      const credential = credentialOf(request);
      if (Option.isNone(credential)) return refuse;
      const device = yield* auth.authenticate(credential.value).pipe(Effect.option);
      if (Option.isNone(device)) return refuse;
      const deviceId = device.value;

      const socket = Effect.gen(function* () {
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        yield* RpcServer.make(group.middleware(DefectGuard), { disableFatalDefects: true }).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.forkScoped,
        );
        return yield* httpEffect;
      }).pipe(
        Effect.provide([handlers, defectGuard]),
        Effect.provideService(CurrentDevice, { id: deviceId }),
      );

      return yield* Effect.raceFirst(
        socket,
        auth.revoked(deviceId).pipe(Effect.as(HttpServerResponse.empty())),
      );
    }).pipe(Effect.provide(RpcSerialization.layerJson)),
  );
