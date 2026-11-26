// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A chunked body with no declared length is sent exactly only through node:http.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DESKTOP_APP_ORIGINS,
  HTTP_PATHS,
  PROTOCOL_VERSION,
  ServerInfo,
  ServerOrigin,
} from "@j3-bots/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { Devices } from "./devices/Devices.ts";
import * as Http from "./http.ts";
import * as TestDomain from "./testing/domain.ts";
import * as TestUpdates from "./testing/update.ts";
import * as WebClient from "./web/WebClient.ts";

/**
 * POSTs `body` to `path` and answers the status. `chunked` sends it in
 * pieces with no declared length, as a streaming client does.
 */
const post = (
  path: string,
  body: string,
  {
    chunked = false,
    contentType = "application/json",
  }: { chunked?: boolean; contentType?: string | null } = {},
) =>
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
          headers: {
            ...(contentType === null ? {} : { "content-type": contentType }),
            ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }),
          },
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

/** Sends a bodiless `method` request to `path` with `headers`, and answers the status, headers and body. */
/** What a client metadata document says of the client, as these tests read it. */
const Document = Schema.Struct({
  client_id: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
});

const ask = (method: string, path: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return yield* Effect.callback<{
      status: number;
      headers: NodeHttp.IncomingHttpHeaders;
      body: string;
    }>((resume) => {
      NodeHttp.request(
        { host: "127.0.0.1", port: address.port, path, method, headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resume(
              Effect.succeed({ status: response.statusCode ?? 0, headers: response.headers, body }),
            );
          });
        },
      ).end();
    });
  });

const pairRequest = (name: string, code = "0000000000") => JSON.stringify({ code, name });

/** The headers of a WebSocket upgrade, as a browser sends them. */
const upgrade = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

/** `host` at the port the test server bound. */
const atPort = (host: string) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return `${host}:${address.port}`;
  });

/** Every line the client listener logs while these tests run, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

/** The logged lines that mention `text`. */
const logLinesWith = (text: string) => logged.filter((line) => line.includes(text));

/** The client listener over the test domain, its configuration changed by `configure`. */
const served = (configure: (config: ServerConfigShape) => ServerConfigShape) =>
  Http.serve(NodeHttpServer.layerTest, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          return configure(yield* ServerConfig);
        }),
      ),
    ),
    Layer.provide(WebClient.statusLayer),
    Layer.provide(TestUpdates.layer),
    Layer.provideMerge(TestDomain.layer),
  );

it.layer(served((config) => config))("http", (it) => {
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
      // Any other origin is answered as a request with none: a preflight too.
      const corsHeaders = (headers: NodeHttp.IncomingHttpHeaders) =>
        Object.keys(headers).filter(
          (name) => name.startsWith("access-control-") || name === "vary",
        );
      const plain = yield* ask("OPTIONS", HTTP_PATHS.socketTicket, {
        "access-control-request-method": "POST",
      });
      for (const origin of ["https://example.com", "j3bots://elsewhere", "null"]) {
        const preflight = yield* ask("OPTIONS", HTTP_PATHS.socketTicket, {
          origin,
          "access-control-request-method": "POST",
        });
        assert.strictEqual(preflight.status, plain.status);
        assert.deepStrictEqual(corsHeaders(preflight.headers), corsHeaders(plain.headers));
        const info = yield* ask("GET", HTTP_PATHS.server, { origin });
        assert.deepStrictEqual(corsHeaders(info.headers), []);
      }
    }),
  );
  it.effect("refuses a pairing request that is not JSON, and does not count it as an attempt", () =>
    Effect.gen(function* () {
      const devices = yield* Devices;
      yield* devices.unlock;
      // Four wrong codes: one more locks pairing. A media type's case does not matter.
      for (const contentType of [
        "application/json",
        "Application/JSON",
        "application/json; charset=utf-8",
        "APPLICATION/JSON;charset=UTF-8",
      ]) {
        assert.strictEqual(
          yield* post(HTTP_PATHS.pair, pairRequest("Phone"), { contentType }),
          400,
        );
      }
      // What a web page can send anywhere without a preflight, none at all, and
      // a JSON suffix type, which is not JSON to this route.
      for (const contentType of [
        "text/plain",
        "text/plain; charset=utf-8",
        "application/x-www-form-urlencoded",
        null,
        "application/*+json",
        "application/ld+json",
      ]) {
        assert.strictEqual(
          yield* post(HTTP_PATHS.pair, pairRequest("Phone"), { contentType }),
          415,
        );
      }
      // The fifth wrong code is the one that locks.
      assert.strictEqual(yield* post(HTTP_PATHS.pair, pairRequest("Phone")), 400);
      assert.strictEqual(yield* post(HTTP_PATHS.pair, pairRequest("Phone")), 429);
      yield* devices.unlock;
    }),
  );

  it.effect("pairs a device that sends its code as JSON", () =>
    Effect.gen(function* () {
      const { code } = yield* (yield* Devices).startPairing;
      const paired = yield* post(HTTP_PATHS.pair, pairRequest("Phone", code), {
        contentType: "application/json; charset=utf-8",
      });
      assert.strictEqual(paired, 200);
    }),
  );

  it.effect("answers 403, before routing, a Host a web page may have rebound here", () =>
    Effect.gen(function* () {
      const host = yield* atPort("evil.example");
      for (const path of [HTTP_PATHS.server, "/health", "/no-such-path", "/pair"]) {
        assert.strictEqual((yield* ask("GET", path, { host })).status, 403, path);
      }
      const pairing = yield* ask("POST", HTTP_PATHS.pair, {
        host,
        "content-type": "application/json",
      });
      assert.strictEqual(pairing.status, 403);
      for (const socket of [HTTP_PATHS.rpc, HTTP_PATHS.browser]) {
        assert.strictEqual((yield* ask("GET", socket, { ...upgrade, host })).status, 403, socket);
      }
      // The desktop app's origin does not get a preflight answered either.
      const preflight = yield* ask("OPTIONS", HTTP_PATHS.socketTicket, {
        host,
        origin: DESKTOP_APP_ORIGINS.production,
        "access-control-request-method": "POST",
      });
      assert.strictEqual(preflight.status, 403);
      assert.isUndefined(preflight.headers["access-control-allow-origin"]);
    }),
  );

  it.effect("says why it refuses a name, and logs the name once with what would serve it", () =>
    Effect.gen(function* () {
      const host = yield* atPort("machine.local");
      const refused = yield* ask("GET", "/", { host });
      assert.strictEqual(refused.status, 403);
      assert.match(refused.headers["content-type"] ?? "", /^text\/plain/);
      assert.include(refused.body, "localhost");
      assert.include(refused.body, "publicOrigin");
      yield* ask("GET", HTTP_PATHS.server, { host });
      const lines = logLinesWith("machine.local");
      assert.lengthOf(lines, 1);
      assert.include(lines[0], "publicOrigin is not set");
    }),
  );

  it.effect("stops logging refused names after a few, however many a page sends", () =>
    Effect.gen(function* () {
      for (let index = 0; index < 40; index++) {
        const refused = yield* ask("GET", "/", { host: yield* atPort(`flood-${index}.example`) });
        assert.strictEqual(refused.status, 403);
      }
      const lines = logLinesWith("flood-");
      assert.isAbove(lines.length, 0);
      assert.isBelow(lines.length, 40);
    }),
  );

  it.effect("serves a Host that names it as a client reaches it", () =>
    Effect.gen(function* () {
      for (const name of ["127.0.0.1", "localhost", "[::1]", "10.0.2.2"]) {
        const host = yield* atPort(name);
        assert.strictEqual((yield* ask("GET", HTTP_PATHS.server, { host })).status, 200, name);
        // The upgrade reaches the socket's own check, which wants a credential.
        assert.strictEqual((yield* ask("GET", HTTP_PATHS.rpc, { ...upgrade, host })).status, 401);
      }
    }),
  );
});

it.layer(
  served((config) => ({
    ...config,
    publicOrigin: Option.some(ServerOrigin.make("https://bots.example.com")),
  })),
)("http behind a proxy", (it) => {
  it.effect("serves its public origin's name, as a proxy that keeps the Host sends it", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* ask("GET", HTTP_PATHS.server, { host: "bots.example.com" })).status,
        200,
      );
      const refused = yield* ask("GET", HTTP_PATHS.server, { host: "other.example.com" });
      assert.strictEqual(refused.status, 403);
      // A page on the refused name reads the answer; only the log names the server's own.
      assert.notInclude(refused.body, "bots.example.com");
      const lines = logLinesWith("other.example.com");
      assert.lengthOf(lines, 1);
      assert.include(lines[0], "bots.example.com");
    }),
  );

  it.effect("serves its OAuth client's metadata document there, one per authorization server", () =>
    Effect.gen(function* () {
      const host = { host: "bots.example.com" };
      const served = yield* ask("GET", "/oauth/client/auth.example.com/tenant", host);
      assert.strictEqual(served.status, 200);
      const document = yield* Schema.decodeEffect(Schema.fromJsonString(Document))(served.body);
      assert.deepInclude(document, {
        client_id: "https://bots.example.com/oauth/client/auth.example.com/tenant",
        redirect_uris: [
          "https://bots.example.com/oauth/callback/auth.example.com/tenant",
          "http://127.0.0.1/oauth/callback/auth.example.com/tenant",
        ],
      });
      // An address it never names has no document.
      assert.strictEqual((yield* ask("GET", "/oauth/client/", host)).status, 404);
    }),
  );
});

it.layer(
  served((config) => ({
    ...config,
    tls: Option.some({ certPath: "tls/bots.crt", keyPath: "tls/bots.key" }),
  })),
)("http with TLS", (it) => {
  it.effect(
    "leaves the Host alone: a certificate names the server, and a proxy may name anything",
    () =>
      Effect.gen(function* () {
        const host = yield* atPort("bots.example.com");
        assert.strictEqual((yield* ask("GET", HTTP_PATHS.server, { host })).status, 200);
        assert.strictEqual((yield* ask("GET", HTTP_PATHS.rpc, { ...upgrade, host })).status, 401);
      }),
  );
});
