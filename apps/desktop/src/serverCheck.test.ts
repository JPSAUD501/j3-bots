// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The servers the check meets are plain node:http servers on loopback.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import { HTTP_PATHS, PROTOCOL_VERSION } from "@j3-bots/contracts";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { checkServer } from "./serverCheck.ts";

/** A loopback server answering with `handle`, at the origin this answers; closed with the scope. */
const serve = (handle: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handle);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.die("not an IP listener")
        : Schema.decodeEffect(ServerOrigin)(`http://127.0.0.1:${address.port}`).pipe(Effect.orDie);
    }),
  );

const info = JSON.stringify({
  protocolVersion: PROTOCOL_VERSION,
  version: "0.0.0",
  startedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("finds a J3 Bots server, and never follows a redirect to one", () =>
  Effect.gen(function* () {
    const real = yield* serve((request, response) => {
      if (request.url !== HTTP_PATHS.server) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/json" }).end(info);
    });
    const redirecting = yield* serve((request, response) =>
      response.writeHead(302, { location: `${real}${request.url ?? "/"}` }).end(),
    );
    assert.isNull(yield* checkServer(real));
    assert.strictEqual(yield* checkServer(redirecting), "not-j3-bots");
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);
