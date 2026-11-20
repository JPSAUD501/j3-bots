// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ADMIN_PATHS, AdminStatus, PairingGrant } from "./protocol.ts";
import * as Socket from "./socket.ts";

/** The admin socket answered, but not as the server should. */
export class AdminRequestFailed extends Schema.TaggedError<AdminRequestFailed>()(
  "AdminRequestFailed",
  { path: Schema.String },
) {
  override get message(): string {
    return `The running server did not answer ${this.path} as expected. Check its log with \`journalctl --user -u j3-bots\`.`;
  }
}

const TIMEOUT = Duration.seconds(10);

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
    readonly startPairing: (
      socket: string,
    ) => Effect.Effect<Option.Option<PairingGrant>, AdminRequestFailed>;
  }
>()("@j3-bots/server/admin/AdminClient") {}

export const layer = Layer.effect(
  AdminClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ask =
      <A>(path: string, method: "GET" | "POST", schema: Schema.Codec<A, unknown>) =>
      (socket: string) =>
        Effect.gen(function* () {
          const state = yield* Socket.probe(socket);
          if (state !== "live") return Option.none();
          const client = yield* HttpClient.HttpClient;
          // The host is never resolved: the agent dials the socket.
          const request = HttpClientRequest.make(method)(`http://localhost${path}`);
          return yield* client.execute(request).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.timeout(TIMEOUT),
            Effect.asSome,
            Effect.mapError(() => new AdminRequestFailed({ path })),
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
      status: ask(ADMIN_PATHS.status, "GET", AdminStatus),
      startPairing: ask(ADMIN_PATHS.pairing, "POST", PairingGrant),
    });
  }),
);
