// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Effect's client normalizes a request target; only node:http sends one as written.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import {
  CONNECTOR_APP_FRAME_PATH,
  CONNECTOR_APP_FRAME_POLICY,
  VISUAL_FRAME_PATH,
  VISUAL_FRAME_POLICY,
} from "@j3-bots/contracts";
import * as Ports from "../system/Ports.ts";
import * as WebClient from "./WebClient.ts";

const INDEX = "<!doctype html><title>J3 Bots</title>";
const SCRIPT = "console.log('app')";
/** A chunk of the size Vite writes, large enough to be worth compressing. */
const CHUNK = Array.from({ length: 400 }, (_, i) => `export const line${i} = "${i}";`).join("\n");

/**
 * A built client as Vite lays it out, with a private folder beside it, and
 * links inside the build that point into that folder. With `linkedIndex`, the
 * app's `index.html` itself is such a link.
 */
const fixture = Effect.fn("fixture")(function* (linkedIndex: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.makeTempDirectoryScoped();
  const root = path.join(parent, "dist");
  const secrets = path.join(parent, "private");
  yield* fs.makeDirectory(path.join(root, "assets"), { recursive: true });
  yield* fs.makeDirectory(secrets);
  yield* fs.writeFileString(path.join(secrets, "secret.txt"), "private");
  yield* fs.writeFileString(path.join(secrets, "index.html"), "private");
  yield* fs.writeFileString(path.join(parent, "secret.txt"), "private");
  if (linkedIndex) {
    yield* fs.symlink(path.join(secrets, "index.html"), path.join(root, "index.html"));
  } else {
    yield* fs.writeFileString(path.join(root, "index.html"), INDEX);
  }
  yield* fs.writeFileString(path.join(root, "assets", "index-B1x2y3z4.js"), SCRIPT);
  yield* fs.writeFileString(path.join(root, "assets", "chunk-C5d6e7f8.js"), CHUNK);
  yield* fs.writeFileString(path.join(root, "manifest.webmanifest"), "{}");
  yield* fs.writeFileString(path.join(root, VISUAL_FRAME_PATH), "<!doctype html>");
  yield* fs.writeFileString(path.join(root, CONNECTOR_APP_FRAME_PATH), "<!doctype html>");
  yield* fs.symlink(path.join(secrets, "secret.txt"), path.join(root, "leak.txt"));
  yield* fs.symlink(secrets, path.join(root, "linked"));
  return root;
});

/** Runs `effect` against a server with the client's routes and one API route. */
const serving = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | HttpServer.HttpServer>,
  { linkedIndex = false } = {},
) =>
  Effect.gen(function* () {
    const root = yield* fixture(linkedIndex);
    const app = Layer.mergeAll(
      WebClient.routes(root),
      HttpRouter.add("GET", "/api/server", HttpServerResponse.text("api")),
    );
    return yield* effect.pipe(
      Effect.provide(Ports.serve(app, NodeHttpServer.layerTest, { logAddress: false })),
    );
  }).pipe(Effect.scoped);

const get = (url: string, accept = "*/*") =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("accept", accept)),
  );

/** `target` asked for with `headers`, answered with its headers and its bytes as sent. */
const fetched = (target: string, headers: NodeHttp.OutgoingHttpHeaders) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return yield* Effect.callback<{
      readonly status: number;
      readonly headers: NodeHttp.IncomingHttpHeaders;
      readonly body: Buffer;
    }>((resume) => {
      const request = NodeHttp.get(
        { host: "127.0.0.1", port: address.port, path: target, headers },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            ),
          );
        },
      );
      request.on("error", (error) => resume(Effect.die(error)));
    });
  });

/**
 * `target` sent exactly as written, `#` and all, as a client other than a
 * browser can: what the server answers, status and body.
 */
const raw = (target: string, accept = "text/html") =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
    return yield* Effect.callback<{
      readonly status: number;
      readonly location: string | undefined;
      readonly body: string;
    }>((resume) => {
      const request = NodeHttp.get(
        { host: "127.0.0.1", port: address.port, path: target, headers: { accept } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                body,
              }),
            ),
          );
        },
      );
      request.on("error", (error) => resume(Effect.die(error)));
    });
  });

it.layer(NodeServices.layer)("web client", (it) => {
  it.effect("serves the app at its root and at every path it routes itself", () =>
    serving(
      Effect.gen(function* () {
        // `/pair` is a pairing link's page, which the client reads as it loads.
        for (const url of ["/", "/bots/b1/conversation", "/pair"]) {
          const response = yield* get(url, "text/html,application/xhtml+xml");
          assert.strictEqual(response.status, 200, url);
          assert.strictEqual(yield* response.text, INDEX);
          assert.strictEqual(response.headers["content-type"], "text/html; charset=utf-8");
          assert.strictEqual(response.headers["cache-control"], "no-cache");
          assert.strictEqual(response.headers["x-frame-options"], "DENY");
          assert.strictEqual(
            response.headers["content-security-policy"],
            "frame-ancestors 'none'; frame-src 'self'",
          );
        }
      }),
    ),
  );

  it.effect("serves the visual page sandboxed, under a visual's policy, to the client alone", () =>
    serving(
      Effect.gen(function* () {
        const response = yield* get(VISUAL_FRAME_PATH, "text/html");
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["content-security-policy"], VISUAL_FRAME_POLICY);
        assert.isUndefined(response.headers["x-frame-options"]);
      }),
    ),
  );

  it.effect("serves the connector app page sandboxed, under an app's widest policy", () =>
    serving(
      Effect.gen(function* () {
        const response = yield* get(CONNECTOR_APP_FRAME_PATH, "text/html");
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["content-security-policy"], CONNECTOR_APP_FRAME_POLICY);
        assert.isUndefined(response.headers["x-frame-options"]);
      }),
    ),
  );

  it.effect("names each file's media type and caches only hashed assets for good", () =>
    serving(
      Effect.gen(function* () {
        const script = yield* get("/assets/index-B1x2y3z4.js");
        assert.strictEqual(yield* script.text, SCRIPT);
        assert.strictEqual(script.headers["content-type"], "text/javascript; charset=utf-8");
        assert.strictEqual(script.headers["cache-control"], "public, max-age=31536000, immutable");

        const manifest = yield* get("/manifest.webmanifest");
        assert.strictEqual(manifest.headers["content-type"], "application/manifest+json");
        assert.strictEqual(manifest.headers["cache-control"], "no-cache");

        // A page route under assets/ still gets the app, which must not be cached for good.
        const page = yield* get("/assets/settings", "text/html");
        assert.strictEqual(page.headers["content-type"], "text/html; charset=utf-8");
        assert.strictEqual(page.headers["cache-control"], "no-cache");
      }),
    ),
  );

  it.effect("compresses what a browser takes compressed, and still answers a fresh copy with 304", () =>
    serving(
      Effect.gen(function* () {
        const target = "/assets/chunk-C5d6e7f8.js";
        const gzip = yield* fetched(target, { "accept-encoding": "gzip, deflate" });
        assert.strictEqual(gzip.headers["content-encoding"], "gzip");
        assert.include(gzip.headers["vary"], "Accept-Encoding");
        assert.isBelow(gzip.body.length, CHUNK.length / 3);
        assert.strictEqual(NodeZlib.gunzipSync(gzip.body).toString("utf8"), CHUNK);

        const br = yield* fetched(target, { "accept-encoding": "gzip, deflate, br" });
        assert.strictEqual(br.headers["content-encoding"], "br");
        assert.strictEqual(NodeZlib.brotliDecompressSync(br.body).toString("utf8"), CHUNK);

        const plain = yield* fetched(target, {});
        assert.strictEqual(plain.headers["content-encoding"], undefined);
        assert.strictEqual(plain.body.toString("utf8"), CHUNK);

        // The browser sends back the compressed copy's validator.
        const etag = gzip.headers["etag"] ?? "";
        assert.notStrictEqual(etag, "");
        const again = yield* fetched(target, { "accept-encoding": "gzip", "if-none-match": etag });
        assert.strictEqual(again.status, 304);
        assert.strictEqual(again.body.length, 0);
      }),
    ),
  );

  it.effect("answers 404 for a missing file and an unknown API path, never the app", () =>
    serving(
      Effect.gen(function* () {
        assert.strictEqual((yield* get("/assets/missing-0000.js")).status, 404);
        assert.strictEqual((yield* get("/api/unknown", "text/html")).status, 404);
        const api = yield* get("/api/server", "text/html");
        assert.strictEqual(yield* api.text, "api");
      }),
    ),
  );

  it.effect("refuses paths that leave the client's folder, through a link too", () =>
    serving(
      Effect.gen(function* () {
        for (const url of [
          "/assets/..%2f..%2fsecret.txt",
          "/..%2fsecret.txt",
          "/%2e%2e%2fsecret.txt",
          "/leak.txt",
          "/linked/secret.txt",
          "/linked/",
        ]) {
          const response = yield* get(url, "text/html");
          assert.strictEqual(response.status, 404, url);
          assert.notInclude(yield* response.text, "private");
        }
      }),
    ),
  );

  it.effect("reads a raw request target once: a fragment or query never reaches the file", () =>
    serving(
      Effect.gen(function* () {
        for (const target of [
          "/x#/../leak.txt",
          "/x?/../leak.txt",
          "/x#/../linked/secret.txt",
          "/assets#/../../secret.txt",
          "/assets/..%2f..%2fsecret.txt",
          "/..%5csecret.txt",
          "/../secret.txt",
          "/assets/../../secret.txt",
          "/leak.txt#",
          "/linked/secret.txt?x",
        ]) {
          const { status, body } = yield* raw(target);
          assert.notInclude(body, "private", target);
          assert.include([200, 301, 404], status, target);
        }
        // What the guard checked is what is served: the app, for a route.
        assert.strictEqual((yield* raw("/x#/../leak.txt")).body, INDEX);
        assert.strictEqual((yield* raw("/assets/index-B1x2y3z4.js#x", "*/*")).body, SCRIPT);
      }),
    ),
  );

  it.effect("sends a folder's index only behind its slash, and a 304 for a fresh copy", () =>
    serving(
      Effect.gen(function* () {
        // However many slashes lead the path, the redirect stays on this server.
        for (const target of ["/assets", "/.//assets"]) {
          const folder = yield* raw(target);
          assert.strictEqual(folder.status, 301, target);
          assert.strictEqual(folder.location, "/assets/", target);
        }
        const page = yield* get("/");
        const etag = page.headers["etag"] ?? "";
        assert.notStrictEqual(etag, "");
        const again = yield* HttpClient.execute(
          HttpClientRequest.get("/").pipe(HttpClientRequest.setHeader("if-none-match", etag)),
        );
        assert.strictEqual(again.status, 304);
        assert.strictEqual(again.headers["cache-control"], "no-cache");
      }),
    ),
  );

  it.effect("never serves an index.html that links outside the client's folder", () =>
    serving(
      Effect.gen(function* () {
        // `/pair` is a pairing link's page, which the client reads as it loads.
        for (const url of ["/", "/bots/b1/conversation", "/pair"]) {
          const response = yield* get(url, "text/html");
          assert.strictEqual(response.status, 404, url);
          assert.notInclude(yield* response.text, "private");
        }
        assert.strictEqual(yield* (yield* get("/assets/index-B1x2y3z4.js")).text, SCRIPT);
      }),
      { linkedIndex: true },
    ),
  );
});
