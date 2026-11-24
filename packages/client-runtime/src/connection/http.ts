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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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

/**
 * Fails with `onTimeout`'s error unless `effect` ends within `duration`, so a
 * server or a proxy that accepts a request and never answers it strands
 * nothing. Running out interrupts the request, which aborts it.
 */
export const within =
  <E2>(duration: Duration.Duration, onTimeout: () => E2) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(onTimeout()) }));

/**
 * The platform's HTTP client with redirects refused: an answer that redirects
 * fails the request, and nothing is sent where it points. The server never
 * redirects its own routes, so a redirect comes from something in between,
 * and following it would send the request again, with its pairing code or
 * device token, to another address, plain HTTP included. Every request of the
 * runtime's HTTP client goes through it (uploads go through `FileTransfer`).
 * It asks `fetch` for `redirect: "error"`, so the platform's `fetch` must
 * honor that; React Native's own does not.
 */
export const refuseRedirects = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return HttpClient.transformResponse(
      client,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
  }),
);

/** The slowest link a file transfer is waited for: 32 KiB a second, a poor mobile link. */
const SLOW_LINK_BYTES_PER_SECOND = 32 * 1024;
/** The longest any file transfer is waited for, however large. */
const MAX_TRANSFER_WAIT = Duration.minutes(15);

/**
 * How long moving a file of `size` bytes, up or down, may take: a request's
 * wait, plus its bytes over a slow link.
 */
export const transferDeadline = (size: number, requestTimeout: Duration.Duration) =>
  Duration.min(
    MAX_TRANSFER_WAIT,
    Duration.sum(requestTimeout, Duration.seconds(size / SLOW_LINK_BYTES_PER_SECOND)),
  );

/**
 * The routes a client uses over plain HTTP, before and around the RPC socket.
 * Each answers within `requestTimeout` or counts as unreachable.
 */
export const make = Effect.fnUntraced(function* (origin: URL, requestTimeout: Duration.Duration) {
  const client = yield* HttpClient.HttpClient;
  const url = (path: string) => new URL(path, origin).toString();
  const answered = within(requestTimeout, () => new ServerUnreachable());

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
    answered,
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
      answered,
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
      answered,
    );

  /**
   * A socket's address for one ticket, the RPC socket's unless `path` names
   * another, with `query` besides: `ws:` beside `http:`, `wss:` beside `https:`.
   */
  const socketUrl = (
    ticket: string,
    path: string = HTTP_PATHS.rpc,
    query: Readonly<Record<string, string>> = {},
  ) => {
    const socket = new URL(path, origin);
    socket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    for (const [name, value] of Object.entries(query)) socket.searchParams.set(name, value);
    socket.searchParams.set("ticket", ticket);
    return socket.toString();
  };

  return { serverInfo, pair, socketTicket, socketUrl };
});
