// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthWebSocketTicketResult, WsRpcGroup } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { ORCHESTRATION_PROTOCOL } from "./Pin.ts";
import { baseUrl } from "./Supervisor.ts";

// The adapter's one WebSocket to the engine, with the engine's own RPC group.
// Each dial signs in with a fresh one-use ticket bought with the bearer token,
// as the engine's own clients do, so a reconnect never replays a spent ticket.
//
// Stream chunks are acknowledged by the RPC protocol itself: the socket
// protocol advertises acks and the client sends one per chunk it consumes.

const decodeTicket = HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult);

/** The engine treats a client silent for 15 s as gone (**Read** at `db51b67`); ping well inside that. */
const PING_INTERVAL = Duration.seconds(5);
const PING_TIMEOUT = Duration.seconds(12);

export interface ConnectionInput {
  readonly port: number;
  /** Read on every dial, so a renewed token is used from the next reconnect on. */
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
}

/** The socket URL for one dial. Without a ticket the upgrade is refused and the dial retried. */
const socketUrl = Effect.fn("engine.socketUrl")(function* (input: ConnectionInput) {
  const http = yield* HttpClient.HttpClient;
  const token = yield* input.token;
  const url = new URL(`${baseUrl(input.port).replace("http:", "ws:")}/ws`);
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL));
  const ticket = yield* http
    .execute(
      HttpClientRequest.post(`${baseUrl(input.port)}/api/auth/websocket-ticket/rpc`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeTicket),
      Effect.timeout(Duration.seconds(5)),
      Effect.option,
    );
  if (ticket._tag === "Some") url.searchParams.set("wsTicket", Redacted.value(ticket.value.ticket));
  return url.toString();
});

/** A client for the engine's RPC group over one self-healing socket. */
export const makeEngineRpc = Effect.fn("engine.makeEngineRpc")(function* (input: ConnectionInput) {
  const http = yield* HttpClient.HttpClient;
  const protocol = RpcClient.layerProtocolSocket({
    pingInterval: PING_INTERVAL,
    pingTimeout: PING_TIMEOUT,
    retryTransientErrors: true,
    // Doubles from 250 ms up to one dial every 5 s, for as long as the client lives.
    retryPolicy: Schedule.min([
      Schedule.exponential(Duration.millis(250)),
      Schedule.spaced(Duration.seconds(5)),
    ]),
  }).pipe(
    Layer.provide(
      Layer.effect(
        Socket.Socket,
        Socket.makeWebSocket(
          socketUrl(input).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          {
            openTimeout: Duration.seconds(10),
          },
        ),
      ),
    ),
    Layer.provide([Socket.layerWebSocketConstructorGlobal, RpcSerialization.layerJson]),
  );
  // Built into the caller's scope: the socket lives exactly as long as the client.
  const context = yield* Layer.build(protocol);
  return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(context));
});

export type EngineRpc = Effect.Success<ReturnType<typeof makeEngineRpc>>;
