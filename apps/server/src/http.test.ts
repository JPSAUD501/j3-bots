// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A chunked body with no declared length is sent exactly only through node:http.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { DESKTOP_APP_ORIGINS, HTTP_PATHS, PROTOCOL_VERSION, ServerInfo } from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as Http from "./http.ts";
import * as TestDomain from "./testing/domain.ts";
import * as WebClient from "./web/WebClient.ts";

/**
 * POSTs `body` to `path` and answers the status. `chunked` sends it in
 * pieces with no declared length, as a streaming client does.
 */
const post = (path: string, body: string, { chunked = false } = {}) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return yield* Effect.callback<number>((resume) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: "POST",
          headers: chunked
            ? { "content-type": "application/json" }
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (response) => {
          response.resume();
          resume(Effect.succeed(response.statusCode ?? 0));
        },
      );
      // A server that refuses early may close before the whole body is sent.
      request.on("error", () => {});
      if (chunked) {
        for (let start = 0; start < body.length; start += 1024) {
          request.write(body.slice(start, start + 1024));
        }
      } else {
        request.write(body);
      }
      request.end();
    });
  });

/** Sends a bodiless `method` request to `path` with `headers`, and answers the status and headers. */
const ask = (method: string, path: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return yield* Effect.callback<{ status: number; headers: NodeHttp.IncomingHttpHeaders }>(
      (resume) => {
        NodeHttp.request(
          { host: "127.0.0.1", port: address.port, path, method, headers },
          (response) => {
            response.resume();
            resume(Effect.succeed({ status: response.statusCode ?? 0, headers: response.headers }));
          },
        ).end();
      },
    );
  });

const pairRequest = (name: string) => JSON.stringify({ code: "0000000000", name });

it.layer(
  Http.serve(NodeHttpServer.layerTest, { logAddress: false }).pipe(
    Layer.provide(WebClient.statusLayer),
    Layer.provide(TestDomain.layer),
  ),
)("http", (it) => {
  it.effect("tells a client which protocol it speaks before it pairs", () =>
    Effect.gen(function* () {
      const info = yield* HttpClient.get(HTTP_PATHS.server).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ServerInfo)),
      );
      assert.strictEqual(info.protocolVersion, PROTOCOL_VERSION);
    }),
  );

  it.effect("refuses an oversized pairing request before it counts as an attempt", () =>
    Effect.gen(function* () {
      const oversized = pairRequest("x".repeat(8 * 1024));
      // More than the five failures that lock pairing.
      for (let attempt = 0; attempt < 6; attempt++) {
        assert.strictEqual(yield* post(HTTP_PATHS.pair, oversized), 413);
        assert.strictEqual(yield* post(HTTP_PATHS.pair, oversized, { chunked: true }), 413);
      }
      // Pairing is not locked: a wrong code is still only wrong.
      assert.strictEqual(yield* post(HTTP_PATHS.pair, pairRequest("Phone")), 400);
      assert.strictEqual(
        yield* post(HTTP_PATHS.pair, pairRequest("Phone"), { chunked: true }),
        400,
      );
    }),
  );

  it.effect("lets the desktop app's pages, and no other origin, read its answers", () =>
    Effect.gen(function* () {
      for (const origin of Object.values(DESKTOP_APP_ORIGINS)) {
        // The preflight a bearer request from the app's page needs first.
        const preflight = yield* ask("OPTIONS", HTTP_PATHS.socketTicket, {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type,traceparent,b3",
        });
        assert.strictEqual(preflight.headers["access-control-allow-origin"], origin);
        const allowed = preflight.headers["access-control-allow-headers"]?.split(",") ?? [];
        for (const header of ["authorization", "content-type", "traceparent", "b3"]) {
          assert.include(allowed, header);
        }
        assert.isUndefined(preflight.headers["access-control-allow-credentials"]);
        const info = yield* ask("GET", HTTP_PATHS.server, { origin });
        assert.strictEqual(info.status, 200);
        assert.strictEqual(info.headers["access-control-allow-origin"], origin);
      }
      for (const origin of ["https://example.com", "j3bots://elsewhere", "null"]) {
        const preflight = yield* ask("OPTIONS", HTTP_PATHS.socketTicket, {
          origin,
          "access-control-request-method": "POST",
        });
        assert.isUndefined(preflight.headers["access-control-allow-origin"]);
        const info = yield* ask("GET", HTTP_PATHS.server, { origin });
        assert.isUndefined(info.headers["access-control-allow-origin"]);
      }
    }),
  );
});
