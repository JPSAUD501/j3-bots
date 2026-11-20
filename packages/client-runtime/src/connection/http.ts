// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceToken,
  HTTP_PATHS,
  Invalid,
  NotAuthenticated,
  PairRequest,
  PairResult,
  RateLimited,
  ServerInfo,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** The server did not answer, or answered with something outside the contract. */
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  "ServerUnreachable",
  {},
) {
  override get message(): string {
    return "The J3 Bots server could not be reached.";
  }
}

/** The routes a client uses over plain HTTP, before and around the RPC socket. */
export const make = Effect.fnUntraced(function* (origin: URL) {
  const client = yield* HttpClient.HttpClient;
  const url = (path: string) => new URL(path, origin).toString();

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(Effect.mapError(() => new ServerUnreachable()));

  /** Decodes `response` with the schema its status calls for; anything else is unreachable. */
  const decode = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ): Effect.Effect<S["Type"], ServerUnreachable> =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new ServerUnreachable()),
    );

  const serverInfo = send(HttpClientRequest.get(url(HTTP_PATHS.server))).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? decode(response, ServerInfo) : Effect.fail(new ServerUnreachable()),
    ),
  );

  const pair = (request: PairRequest) =>
    HttpClientRequest.post(url(HTTP_PATHS.pair)).pipe(
      HttpClientRequest.schemaBodyJson(PairRequest)(request),
      Effect.mapError(() => new ServerUnreachable()),
      Effect.flatMap(send),
      Effect.flatMap(
        (response): Effect.Effect<PairResult, Invalid | RateLimited | ServerUnreachable> => {
          switch (response.status) {
            case 200:
              return decode(response, PairResult);
            case 400:
              return decode(response, Invalid).pipe(Effect.flatMap(Effect.fail));
            case 429:
              return decode(response, RateLimited).pipe(Effect.flatMap(Effect.fail));
            default:
              return Effect.fail(new ServerUnreachable());
          }
        },
      ),
    );

  /**
   * A 401 carrying the server's own `NotAuthenticated` means the device is not
   * paired or was revoked. Any other 401 comes from something in between, such
   * as a reverse proxy whose own login expired: the server was not reached.
   */
  const socketTicket = (token: Redacted.Redacted<DeviceToken>) =>
    send(
      HttpClientRequest.post(url(HTTP_PATHS.socketTicket)).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    ).pipe(
      Effect.flatMap(
        (response): Effect.Effect<SocketTicketGrant, NotAuthenticated | ServerUnreachable> => {
          switch (response.status) {
            case 200:
              return decode(response, SocketTicketGrant);
            case 401:
              return decode(response, NotAuthenticated).pipe(Effect.flatMap(Effect.fail));
            default:
              return Effect.fail(new ServerUnreachable());
          }
        },
      ),
    );

  /** The RPC socket's address for one ticket: `ws:` beside `http:`, `wss:` beside `https:`. */
  const socketUrl = (ticket: string) => {
    const socket = new URL(HTTP_PATHS.rpc, origin);
    socket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    socket.searchParams.set("ticket", ticket);
    return socket.toString();
  };

  return { serverInfo, pair, socketTicket, socketUrl };
});
