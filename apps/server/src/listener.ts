// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
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

/** Where the server listens for clients, as bound: what `j3-bots pair` prints. */
export class Listener extends Context.Service<Listener, ListenerStatus>()(
  "@j3-bots/server/listener",
) {}

/**
 * The HTTP server clients reach, and what it bound. Without TLS, every
 * connection is checked as it is accepted: one that reached an address that
 * is not loopback or private is closed unread. Start already refused such an
 * address; this keeps one that appears later (a new interface, a lease on a
 * modem's public network) from ever being served.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port, tls, configFile } = yield* ServerConfig;
    const credentials = Option.isSome(tls)
      ? Option.some(yield* Tls.load(tls.value))
      : Option.none();
    const createServer = () => {
      if (Option.isSome(credentials)) {
        const { cert, key } = credentials.value;
        return NodeHttps.createServer({ cert, key });
      }
      const server = NodeHttp.createServer();
      guardConnections(server, isPrivateAddress);
      return server;
    };
    const status = Layer.effect(
      Listener,
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddress(address)) {
          return yield* Effect.die(new Error("The client listener is not on an IP address"));
        }
        return Listener.of({
          scheme: Option.isSome(credentials) ? "https" : "http",
          address: NetAddress.formatIp(address.address),
          port: address.port,
          names: Option.match(credentials, { onNone: () => [], onSome: ({ names }) => names }),
        });
      }),
    );
    return status.pipe(
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
