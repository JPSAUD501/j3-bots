// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import { ServerConfig } from "../config.ts";
import { isWithin } from "../paths.ts";

// The built web client, served on the same origin as the API and the RPC
// socket, so a browser needs no CORS. A path the client routes itself (no
// file extension, asked for as HTML) gets `index.html`. Effect's static
// server refuses paths that leave the folder, answers ranges and validators,
// and names the media type by extension. It follows symbolic links, so the
// file each request would get is checked first by where it really is: a link
// inside the build never publishes a file outside it.

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

const INDEX = "index.html";

/**
 * Whether the file the static server would answer `url` with really lies
 * inside `realRoot`, links resolved. It mirrors the static server's choice:
 * the named file, a folder's `index.html`, or, for a path that names nothing,
 * the app's `index.html`. A path the static server refuses passes, and is
 * refused there.
 */
const servesContainedFile = Effect.fn("WebClient.servesContainedFile")(function* (
  root: string,
  realRoot: string,
  url: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contained = (file: string) =>
    fs.realPath(file).pipe(
      Effect.map((real) => isWithin(realRoot, real)),
      // A file that is not there is answered 404, whatever a link says.
      Effect.orElseSucceed(() => true),
    );
  const decoded = yield* Effect.try({
    try: () => decodeURIComponent(url.split(/[?#]/, 1)[0] ?? ""),
    catch: () => "undecodable",
  }).pipe(Effect.option);
  if (Option.isNone(decoded)) return true;
  const requested = path.resolveWithin(root, decoded.value.replace(/^\/+/, ""));
  if (Option.isNone(requested)) return true;
  const real = yield* fs.realPath(requested.value).pipe(Effect.option);
  if (Option.isNone(real)) return yield* contained(path.join(root, INDEX));
  if (!isWithin(realRoot, real.value)) return false;
  const info = yield* fs.stat(real.value).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "Directory"
    ? yield* contained(path.join(requested.value, INDEX))
    : true;
});

/**
 * The routes that serve a built web client from `root`: every `GET` no other
 * route takes.
 */
export const routes = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realRoot = yield* fs.realPath(root);
      const contained = (url: string) =>
        servesContainedFile(root, realRoot, url).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const serve = (yield* HttpStaticServer.make({ root, spa: true })).pipe(
        Effect.catch(HttpServerRespondable.toResponse),
      );
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requested = pathname(request.url);
        if (requested.startsWith(API_PREFIX)) return HttpServerResponse.empty({ status: 404 });
        if (!(yield* contained(request.url))) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const response = yield* serve;
        if (response.status >= 400) return response;
        const html = response.headers["content-type"]?.startsWith("text/html") === true;
        return HttpServerResponse.setHeaders(response, {
          "cache-control": requested.startsWith("/assets/") && !html ? IMMUTABLE : REVALIDATE,
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
