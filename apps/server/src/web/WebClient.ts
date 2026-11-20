// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import { ServerConfig } from "../config.ts";

// The built web client, served on the same origin as the API and the RPC
// socket, so a browser needs no CORS. A path the client routes itself (no
// file extension, asked for as HTML) gets `index.html`. Effect's static
// server refuses paths that leave the folder, answers ranges and validators,
// and names the media type by extension.

/** Vite names every file under `assets/` by its content hash, so it never changes. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else, `index.html` above all, is checked on every load, so an update shows at once. */
const REVALIDATE = "no-cache";

/** No other site may frame the client: it answers approvals in one click. */
const HTML_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

/** API paths are never the client's, so an unknown one is a 404, not the app. */
const API_PREFIX = "/api/";

const pathname = (url: string) => new URL(url, "http://localhost").pathname;

/**
 * The routes that serve a built web client from `root`: every `GET` no other
 * route takes.
 */
export const routes = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const serve = (yield* HttpStaticServer.make({ root, spa: true })).pipe(
        Effect.catch(HttpServerRespondable.toResponse),
      );
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = pathname(request.url);
        if (path.startsWith(API_PREFIX)) return HttpServerResponse.empty({ status: 404 });
        const response = yield* serve;
        if (response.status >= 400) return response;
        const html = response.headers["content-type"]?.startsWith("text/html") === true;
        return HttpServerResponse.setHeaders(response, {
          "cache-control": path.startsWith("/assets/") && !html ? IMMUTABLE : REVALIDATE,
          "x-content-type-options": "nosniff",
          ...(html ? HTML_HEADERS : {}),
        });
      });
      return HttpRouter.add("GET", "/*", handler);
    }),
  );

/**
 * The configured web client's routes. A client configured by the operator
 * was checked when the configuration loaded; the one in this checkout is
 * served once it is built, and until then the server runs without it.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { webClient } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const built = yield* fs
      .exists(path.join(webClient.directory, "index.html"))
      .pipe(Effect.orElseSucceed(() => false));
    if (built) return routes(webClient.directory);
    yield* Effect.logWarning("The web client is not built, so the server does not serve it", {
      directory: webClient.directory,
    });
    return Layer.empty;
  }),
);
