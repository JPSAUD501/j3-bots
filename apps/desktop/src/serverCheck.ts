// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS, ServerInfo } from "@j3-bots/contracts";
import type { ConnectRefusal, ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** How long the server address screen waits for a server to answer. */
const CHECK_TIMEOUT = Duration.seconds(10);

/**
 * Why no J3 Bots server answers at `origin`, or `null` when one does:
 * `GET /api/server` answers a `ServerInfo`. A server of another protocol
 * version counts: the client says so once it connects, and offers what to do.
 */
export const checkServer = Effect.fn("checkServer")(
  function* (
    origin: ServerOrigin,
  ): Effect.fn.Return<ConnectRefusal | null, never, HttpClient.HttpClient> {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .get(new URL(HTTP_PATHS.server, origin).toString())
      .pipe(Effect.option);
    if (response._tag === "None") return "unreachable";
    if (response.value.status !== 200) return "not-j3-bots";
    const info = yield* HttpClientResponse.schemaBodyJson(ServerInfo)(response.value).pipe(
      Effect.option,
    );
    return info._tag === "Some" ? null : "not-j3-bots";
  },
  Effect.timeoutOrElse({
    duration: CHECK_TIMEOUT,
    orElse: () => Effect.succeed("unreachable" as const),
  }),
);
