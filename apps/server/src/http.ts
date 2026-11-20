// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HTTP_PATHS,
  NotAuthenticated,
  PROTOCOL_VERSION,
  ServerInfo,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../package.json" with { type: "json" };
import { DeviceAuth } from "./auth/DeviceAuth.ts";

/** 200 once the server is serving, which is after the database is migrated. */
const health = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" }));

const serverInfo = Layer.unwrap(
  Effect.gen(function* () {
    const info: ServerInfo = {
      protocolVersion: PROTOCOL_VERSION,
      version: packageJson.version,
      startedAt: yield* DateTime.now,
    };
    const response = yield* HttpServerResponse.schemaJson(ServerInfo)(info).pipe(Effect.orDie);
    return HttpRouter.add("GET", HTTP_PATHS.server, Effect.succeed(response));
  }),
);

const bearerToken = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers["authorization"];
  return authorization?.startsWith("Bearer ")
    ? Option.some(authorization.slice("Bearer ".length))
    : Option.none();
};

const unauthorized = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

const socketTicket = HttpRouter.add(
  "POST",
  HTTP_PATHS.socketTicket,
  Effect.gen(function* () {
    const auth = yield* DeviceAuth;
    const token = bearerToken(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(token)) return unauthorized;
    const device = yield* auth
      .authenticate({ _tag: "bearer", token: token.value })
      .pipe(Effect.option);
    if (Option.isNone(device)) return unauthorized;
    const grant = yield* auth.issueTicket(device.value);
    return yield* HttpServerResponse.schemaJson(SocketTicketGrant)(grant).pipe(Effect.orDie);
  }),
);

/** The routes outside the RPC socket. */
export const routes = Layer.mergeAll(health, serverInfo, socketTicket);

/**
 * Every route, served on whichever `HttpServer` is provided. The RPC socket
 * (`RpcSocket.layer`) joins `routes` here once the server has handlers for
 * `J3Rpcs`.
 */
export const layer = HttpRouter.serve(routes);
