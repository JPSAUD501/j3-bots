// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  ADMIN_PATHS,
  AdminStatus,
  PairingOffer,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
  RunningWorkReply,
  ServerReadiness,
} from "./protocol.ts";
import * as Socket from "./socket.ts";

/** The admin socket answered, but not as the server should. */
export class AdminRequestFailed extends Schema.TaggedError<AdminRequestFailed>()(
  "AdminRequestFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The running server did not answer ${this.path} as expected. If \`j3-bots\` was just updated, restart the service with \`systemctl --user restart j3-bots\`; otherwise check its log with \`journalctl --user -u j3-bots\`.`;
  }
}

const TIMEOUT = Duration.seconds(10);
/** A provider connection waits for the engine's restart, up to a minute on the server's side. */
const CONNECT_TIMEOUT = Duration.seconds(90);

/**
 * The running server, as `j3-bots` commands see it over its admin socket.
 * Each answer is none when no server runs on that socket.
 */
export class AdminClient extends Context.Service<
  AdminClient,
  {
    readonly status: (
      socket: string,
    ) => Effect.Effect<Option.Option<AdminStatus>, AdminRequestFailed>;
    /** The status reply, read only as far as `j3-bots update` needs it. */
    readonly readiness: (
      socket: string,
    ) => Effect.Effect<Option.Option<ServerReadiness>, AdminRequestFailed>;
    readonly runningWork: (
      socket: string,
    ) => Effect.Effect<Option.Option<RunningWorkReply>, AdminRequestFailed>;
    /**
     * A code for a new device, or until when pairing is locked. With `unlock`,
     * the lock is lifted first, so the answer is always a code.
     */
    readonly startPairing: (
      socket: string,
      options: { readonly unlock: boolean },
    ) => Effect.Effect<Option.Option<PairingOffer>, AdminRequestFailed>;
    readonly connectProviders: (
      socket: string,
      request: ProviderConnectionRequest,
    ) => Effect.Effect<Option.Option<ProviderConnectionOutcome>, AdminRequestFailed>;
  }
>()("@j3-bots/server/admin/AdminClient") {}

export const layer = Layer.effect(
  AdminClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ask =
      <A>(
        path: string,
        method: "GET" | "POST",
        schema: Schema.Codec<A, unknown>,
        /** Whether the answer carries a secret, such as a pairing code. */
        secretAnswer: boolean,
        body: Option.Option<
          (
            request: HttpClientRequest.HttpClientRequest,
          ) => Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>
        > = Option.none(),
        timeout: Duration.Duration = TIMEOUT,
      ) =>
      (socket: string) =>
        Effect.gen(function* () {
          const state = yield* Socket.probe(socket);
          if (state !== "live") return Option.none();
          const client = yield* HttpClient.HttpClient;
          // The host is never resolved: the agent dials the socket.
          const request = HttpClientRequest.make(method)(`http://localhost${path}`);
          return yield* Option.match(body, {
            onNone: () => Effect.succeed(request),
            onSome: (write) => write(request),
          }).pipe(
            Effect.flatMap((request) => client.execute(request)),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.timeout(timeout),
            Effect.asSome,
            // A failure may hold the request or the answer: a request's body
            // may hold a key, and an answer that did not decode may hold a code.
            Effect.mapError(
              (cause) =>
                new AdminRequestFailed({
                  path,
                  cause: Option.isSome(body)
                    ? "Left out: the request carried a body."
                    : secretAnswer
                      ? "Left out: the answer carries a secret."
                      : cause,
                }),
            ),
          );
        }).pipe(
          Effect.provide(
            NodeHttpClient.layerNodeHttpNoAgent.pipe(
              Layer.provide(NodeHttpClient.layerAgentOptions({ socketPath: socket })),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
    return AdminClient.of({
      status: ask(ADMIN_PATHS.status, "GET", AdminStatus, false),
      readiness: ask(ADMIN_PATHS.status, "GET", ServerReadiness, false),
      runningWork: ask(ADMIN_PATHS.runningWork, "GET", RunningWorkReply, false),
      startPairing: Effect.fn("AdminClient.startPairing")(function* (
        socket: string,
        options: { readonly unlock: boolean },
      ) {
        const path = options.unlock ? ADMIN_PATHS.unlockPairing : ADMIN_PATHS.pairing;
        return yield* ask(path, "POST", PairingOffer, true)(socket);
      }),
      connectProviders: Effect.fn("AdminClient.connectProviders")(function* (
        socket: string,
        request: ProviderConnectionRequest,
      ) {
        return yield* ask(
          ADMIN_PATHS.providerConnection,
          "POST",
          ProviderConnectionOutcome,
          false,
          Option.some(HttpClientRequest.schemaBodyJson(ProviderConnectionRequest)(request)),
          CONNECT_TIMEOUT,
        )(socket);
      }),
    });
  }),
);
