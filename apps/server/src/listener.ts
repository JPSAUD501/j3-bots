// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import type { ListenerStatus } from "./admin/protocol.ts";
import { ServerConfig } from "./config.ts";
import { guardConnections, isPrivateAddress } from "./system/Network.ts";
import * as Tls from "./system/Tls.ts";

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
    const { host, port, tls } = yield* ServerConfig;
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
    // On shutdown the server stops accepting connections and gives open
    // requests and sockets this long to finish.
    return status.pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host, port, gracefulShutdownTimeout: "5 seconds" }),
      ),
    );
  }),
);
