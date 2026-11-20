// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import type { ListenerStatus } from "./admin/protocol.ts";
import { ServerConfig } from "./config.ts";
import { guardConnections, isPrivateAddress } from "./system/Network.ts";
import * as Ports from "./system/Ports.ts";
import * as Tls from "./system/Tls.ts";

/**
 * `ws` takes `closeTimeout`, how long a closing socket waits for the peer's
 * close frame before it is destroyed (30 s by default). Its type definitions
 * do not name it yet.
 */
interface WebSocketOptions extends NonNullable<NodeHttpServer.Options["websocket"]> {
  readonly closeTimeout: number;
}

/**
 * On shutdown, open requests get this long to finish, and each open socket
 * this long to answer its close. Both, and the engine's own stop, fit well
 * inside the service's stop timeout (`service/unit.ts`).
 */
const HTTP_GRACE = "5 seconds";
const WEBSOCKET_CLOSE_MILLIS = 2_000;

const websocket: WebSocketOptions = { closeTimeout: WEBSOCKET_CLOSE_MILLIS };

/**
 * Where the server listens for clients, as bound: what `j3-bots pair` prints
 * and a webhook's address names. The domain is built before the listener
 * binds (`Ports.serve`), so this is made beneath both and completed once the
 * listener has bound; a reader waits for it. Clients only ever reach the
 * server once it has.
 */
export class Listener extends Context.Service<Listener, Deferred.Deferred<ListenerStatus>>()(
  "@j3-bots/server/listener",
) {}

/** `Listener`, before the client listener binds. */
export const unbound = Layer.effect(Listener, Deferred.make<ListenerStatus>());

/**
 * Completes `Listener` with where the HTTP server beneath bound, served over
 * `scheme` with a certificate for `names`.
 */
const report = (scheme: ListenerStatus["scheme"], names: ReadonlyArray<string>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { address } = yield* HttpServer.HttpServer;
      if (!NetAddress.isInetAddress(address)) {
        return yield* Effect.die(new Error("The client listener is not on an IP address"));
      }
      yield* Deferred.succeed(yield* Listener, {
        scheme,
        address: NetAddress.formatIp(address.address),
        port: address.port,
        names,
      });
    }),
  );

/**
 * The HTTP server clients reach, reporting where it bound. When the
 * configuration serves private addresses only (`privateOnly`), every
 * connection is checked as it is accepted, over HTTP and HTTPS alike: one that
 * reached an address that is not loopback or private is closed unread. Start
 * already refused such an address; this keeps one that appears later (a new
 * interface, a lease on a modem's public network) from ever being served.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port, tls, privateOnly, configFile } = yield* ServerConfig;
    const credentials = Option.isSome(tls)
      ? Option.some(yield* Tls.load(tls.value))
      : Option.none();
    const createServer = () => {
      const server = Option.match(credentials, {
        onNone: () => NodeHttp.createServer(),
        onSome: ({ cert, key }) => NodeHttps.createServer({ cert, key }),
      });
      if (privateOnly) guardConnections(server, isPrivateAddress);
      return server;
    };
    return report(
      Option.isSome(credentials) ? "https" : "http",
      Option.match(credentials, { onNone: () => [], onSome: ({ names }) => names }),
    ).pipe(
      Layer.provideMerge(
        Ports.listen(
          createServer,
          { host, port, gracefulShutdownTimeout: HTTP_GRACE, websocket },
          { label: "the server", setting: "port", host, port },
          configFile,
        ),
      ),
    );
  }),
);
