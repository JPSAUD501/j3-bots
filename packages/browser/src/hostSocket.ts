// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserHostRpcs } from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import {
  type PageHost,
  type PageHostClient,
  pageHostHandlers,
  remotePageHost,
} from "./PageHost.ts";

// The page host protocol over one WebSocket (decision 0110). The desktop app
// dials the server (`HTTP_PATHS.browserHost`) and answers `BrowserHostRpcs`
// on that socket; the server, which accepted it, is the caller. Both ends
// speak Effect RPC's JSON serialization, one message per frame.

/**
 * The server pings a host this often, and a host that hears nothing from
 * the server for `HOST_SOCKET_SILENCE` takes the socket for dropped.
 */
export const HOST_SOCKET_PING = Duration.seconds(15);
export const HOST_SOCKET_SILENCE = Duration.seconds(45);

/** Why a host's link to the server ended. */
export type HostSocketEnd = "closed" | "silent";

/** `socket`, with `heard` run for every batch read from it. */
const tapped = (socket: Socket.Socket, heard: Effect.Effect<void>): Socket.Socket =>
  Socket.make({
    reader: Effect.map(socket.reader, (reader) => ({
      ...reader,
      pull: Effect.tap(reader.pull, () => heard),
    })),
    writer: socket.writer,
  });

/**
 * Answers the server's calls on `socket`, which the host dialed, with `host`,
 * until the socket closes or the server falls silent for `silence`. Ends
 * with why; the caller dials again.
 */
export const serveHostOnSocket = (
  host: PageHost,
  socket: Socket.Socket,
  options: { readonly silence?: Duration.Input | undefined } = {},
): Effect.Effect<HostSocketEnd> =>
  Effect.gen(function* () {
    const silence = Duration.toMillis(options.silence ?? HOST_SOCKET_SILENCE);
    const ended = yield* Deferred.make<HostSocketEnd>();
    let lastHeard = yield* Clock.currentTimeMillis;
    const heard = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        lastHeard = now;
      }),
    );
    // A socket server that has exactly one client: the socket the host dialed.
    const one = SocketServer.SocketServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 0),
      run: Effect.fn("serveHostOnSocket.run")(function* (handler) {
        yield* Effect.ignore(handler(tapped(socket, heard)));
        yield* Deferred.succeed(ended, "closed");
        return yield* Effect.never;
      }),
    });
    const watchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.millis(Math.max(1_000, silence / 3)));
        const now = yield* Clock.currentTimeMillis;
        if (now - lastHeard > silence) return yield* Deferred.succeed(ended, "silent");
      }
    });
    const protocol = RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide(Layer.succeed(SocketServer.SocketServer, one)),
      Layer.provide(Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.json)),
    );
    yield* RpcServer.make(BrowserHostRpcs, { disableFatalDefects: true }).pipe(
      Effect.provide(Layer.merge(pageHostHandlers(host), protocol)),
      Effect.forkScoped,
    );
    yield* Effect.forkScoped(watchdog);
    return yield* Deferred.await(ended);
  }).pipe(Effect.scoped);

/**
 * The host at the other end of `socket`, which the server accepted, for as
 * long as the scope lives. The server pings it every `HOST_SOCKET_PING`; a
 * call the socket loses fails as `closed`.
 */
export const pageHostOnSocket = (
  socket: Socket.Socket,
): Effect.Effect<
  { readonly host: PageHost; readonly client: PageHostClient },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // Built in the caller's scope, which the protocol and the client live as long as.
    const protocol = yield* RpcClient.makeProtocolSocket({
      pingInterval: HOST_SOCKET_PING,
      pingTimeout: HOST_SOCKET_SILENCE,
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    );
    const client = yield* RpcClient.make(BrowserHostRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    return { host: remotePageHost(client), client };
  });
