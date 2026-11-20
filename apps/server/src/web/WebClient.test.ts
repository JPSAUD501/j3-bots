// SPDX-License-Identifier: AGPL-3.0-or-later
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
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WebClient from "./WebClient.ts";

const INDEX = "<!doctype html><title>J3 Bots</title>";
const SCRIPT = "console.log('app')";

/** A built client as Vite lays it out, with a file beside it that must stay private. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.makeTempDirectoryScoped();
  const root = path.join(parent, "dist");
  yield* fs.makeDirectory(path.join(root, "assets"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "index.html"), INDEX);
  yield* fs.writeFileString(path.join(root, "assets", "index-B1x2y3z4.js"), SCRIPT);
  yield* fs.writeFileString(path.join(root, "manifest.webmanifest"), "{}");
  yield* fs.writeFileString(path.join(parent, "secret.txt"), "private");
  return root;
});

/** Runs `effect` against a server with the client's routes and one API route. */
const serving = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const root = yield* fixture;
    const app = Layer.mergeAll(
      WebClient.routes(root),
      HttpRouter.add("GET", "/api/server", HttpServerResponse.text("api")),
    );
    return yield* effect.pipe(
      Effect.provide(HttpRouter.serve(app).pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    );
  }).pipe(Effect.scoped);

const get = (url: string, accept = "*/*") =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("accept", accept)),
  );

it.layer(NodeServices.layer)("web client", (it) => {
  it.effect("serves the app at its root and at every path it routes itself", () =>
    serving(
      Effect.gen(function* () {
        for (const url of ["/", "/bots/b1/conversation"]) {
          const response = yield* get(url, "text/html,application/xhtml+xml");
          assert.strictEqual(response.status, 200, url);
          assert.strictEqual(yield* response.text, INDEX);
          assert.strictEqual(response.headers["content-type"], "text/html; charset=utf-8");
          assert.strictEqual(response.headers["cache-control"], "no-cache");
          assert.strictEqual(response.headers["x-frame-options"], "DENY");
        }
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

  it.effect("refuses paths that leave the client's folder", () =>
    serving(
      Effect.gen(function* () {
        for (const url of [
          "/assets/..%2f..%2fsecret.txt",
          "/..%2fsecret.txt",
          "/%2e%2e%2fsecret.txt",
        ]) {
          const response = yield* get(url);
          assert.strictEqual(response.status, 404, url);
          assert.notInclude(yield* response.text, "private");
        }
      }),
    ),
  );
});
