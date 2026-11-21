// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The test runs real HTTP servers for the platform's fetch to reach.
import * as NodeHttp from "node:http";
import { HTTP_PATHS, PairingCode } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Http from "./http.ts";

/** A server on a loopback port that answers every request with `answer`, and counts them. */
const serve = (answer: (response: NodeHttp.ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeHttp.Server; readonly requests: Array<string> }>(
      (resume) => {
        const requests: Array<string> = [];
        const server = NodeHttp.createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          request.resume();
          answer(response);
        });
        server.listen({ host: "127.0.0.1", port: 0 }, () =>
          resume(Effect.succeed({ server, requests })),
        );
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map(({ server, requests }) => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return { origin: new URL(`http://127.0.0.1:${port}`), requests };
    }),
  );

const code = Schema.decodeSync(PairingCode)("ABCDEFGH23");

it.effect("refuses a redirect when pairing, and never sends the code where it points", () =>
  Effect.gen(function* () {
    const elsewhere = yield* serve((response) => response.writeHead(200).end("{}"));
    const server = yield* serve((response) =>
      response
        .writeHead(307, { location: new URL(HTTP_PATHS.pair, elsewhere.origin).toString() })
        .end(),
    );
    const http = yield* Http.make(server.origin, Duration.seconds(5)).pipe(
      Effect.provide(Http.refuseRedirects.pipe(Layer.provide(FetchHttpClient.layer))),
    );
    const failure = yield* http.pair({ code, name: "Test phone" }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ServerUnreachable");
    assert.deepStrictEqual(server.requests, [`POST ${HTTP_PATHS.pair}`]);
    assert.deepStrictEqual(elsewhere.requests, []);
  }),
);
