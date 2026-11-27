// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Mime from "effect/http/Mime";
import {
  CONNECTOR_APP_FRAME_PATH,
  CONNECTOR_APP_FRAME_POLICY,
  VISUAL_FRAME_PATH,
  VISUAL_FRAME_POLICY,
} from "@j3-bots/contracts";
import type { AdminStatus } from "../admin/protocol.ts";
import { ServerConfig } from "../config.ts";
import { isWithin } from "../paths.ts";
import { containedFile, INDEX, isBuilt } from "./built.ts";

// The built web client, served on the same origin as the API and the RPC
// socket, so a browser needs no CORS. A path the client routes itself (no
// file extension, asked for as HTML) gets `index.html`.
//
// Each request is resolved once, here: the request target is parsed as a URL,
// its path decoded and resolved inside the folder, links followed to where
// the file really is, and that real path, checked to lie inside the folder,
// is the file served. No second parser reads the target, so the file checked
// is always the file sent, and a link inside the build never publishes a file
// outside it.
//
// Text files (scripts, styles, pages, the manifest) are sent compressed to a
// browser that takes it, Brotli or gzip, as `Accept-Encoding` asks: the
// client's first load is about a third of its size gzipped. So every answer
// says it varies by `Accept-Encoding`, and its validator is weak: the same
// for each encoding a file is sent in, which a browser sends back and a 304
// answers with the same headers. Nothing the client's files hold is secret,
// so compression reveals nothing (BREACH).

/** Vite names every file under `assets/` by its content hash, so it never changes. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else, `index.html` above all, is checked on every load, so an update shows at once. */
const REVALIDATE = "no-cache";

/**
 * No other site may frame the client: it answers approvals in one click. The
 * client frames only its own visual page, so a bot's visual that navigates
 * its frame elsewhere, by script or a refresh, is stopped
 * (docs/architecture/security.md, "Visuals").
 */
const HTML_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'; frame-src 'self'",
  "x-frame-options": "DENY",
};

/** The page a visual is drawn in: its own policy, sandboxed, framed only by the client. */
const VISUAL_FRAME_HEADERS = { "content-security-policy": VISUAL_FRAME_POLICY };

/**
 * The page a connector's app is drawn in: the widest policy an app may have,
 * which the app's document narrows, sandboxed, framed only by the client.
 */
const CONNECTOR_APP_FRAME_HEADERS = { "content-security-policy": CONNECTOR_APP_FRAME_POLICY };

/** The headers an HTML page of the client is served with. */
const htmlHeaders = (path: string) =>
  path === VISUAL_FRAME_PATH
    ? VISUAL_FRAME_HEADERS
    : path === CONNECTOR_APP_FRAME_PATH
      ? CONNECTOR_APP_FRAME_HEADERS
      : HTML_HEADERS;

/** API paths are never the client's, so an unknown one is a 404, not the app. */
const API_PREFIX = "/api/";
const ASSETS_PREFIX = "/assets/";

const notFound = HttpServerResponse.empty({ status: 404 });

/** What a request asks the client's folder for. */
type Target =
  /** The file at this real path, inside the folder. */
  | { readonly _tag: "file"; readonly file: string }
  /** A folder named without its trailing slash, at this local location. */
  | { readonly _tag: "redirect"; readonly location: string }
  | { readonly _tag: "not-found" };

const NOT_FOUND: Target = { _tag: "not-found" };
const fileTarget = (file: string): Target => ({ _tag: "file", file });
const redirectTarget = (location: string): Target => ({ _tag: "redirect", location });

/** Text types are sent with their encoding, which Vite always writes as UTF-8. */
const mediaType = (file: string) =>
  Option.match(Mime.getType(file), {
    onNone: () => "application/octet-stream",
    onSome: (type) =>
      type.startsWith("text/") || type === "application/json" || type === "image/svg+xml"
        ? `${type}; charset=utf-8`
        : type,
  });

const acceptsHtml = (accept: string | undefined) =>
  accept !== undefined && accept.toLowerCase().includes("text/html");

/** The URL's path, decoded; none for one that does not decode or names a NUL. */
const decodedPath = (pathname: string) => {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\u0000") ? Option.none() : Option.some(decoded);
  } catch {
    return Option.none();
  }
};

/** Whether the tags in `ifNoneMatch` include `etag`, compared weakly as a cache does. */
const matchesEtag = (ifNoneMatch: string, etag: string) => {
  const opaque = (tag: string) => tag.trim().replace(/^W\//i, "");
  return (
    ifNoneMatch.trim() === "*" ||
    ifNoneMatch.split(",").some((candidate) => opaque(candidate) === opaque(etag))
  );
};

/**
 * `etag` as a weak validator: a file is the same in each encoding the
 * compression sends it in, byte for byte only in one.
 */
const weak = (etag: string) => (etag.startsWith("W/") ? etag : `W/${etag}`);

/**
 * Whether the browser's copy, described by the request's validators, is still
 * the file's. `If-None-Match` wins over `If-Modified-Since` (RFC 9110 §13.1.3).
 */
const stillFresh = (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
) => {
  const etag = response.headers["etag"];
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch !== undefined) return etag !== undefined && matchesEtag(ifNoneMatch, etag);
  const ifModifiedSince = request.headers["if-modified-since"];
  const lastModified = response.headers["last-modified"];
  if (ifModifiedSince === undefined || lastModified === undefined) return false;
  const since = Date.parse(ifModifiedSince);
  const modified = Date.parse(lastModified);
  return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since;
};

/** The routes that serve a built web client from `root`: every `GET` no other route takes. */
export const routes = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realRoot = yield* fs.realPath(root);

      /** The file at `location`, if it really is a file inside the folder. */
      const containedTarget = (location: string) =>
        containedFile(realRoot, location).pipe(
          Effect.map(Option.match({ onNone: () => NOT_FOUND, onSome: fileTarget })),
        );

      /** The one file, or redirect, a request names. */
      const resolve = Effect.fn("WebClient.resolve")(function* (
        request: HttpServerRequest.HttpServerRequest,
        url: URL,
        decoded: string,
      ) {
        // Every leading slash is part of the URL, not the filesystem's root.
        const requested = path.resolveWithin(root, decoded.replace(/^\/+/, ""));
        if (Option.isNone(requested)) return NOT_FOUND;
        const real = yield* fs.realPath(requested.value).pipe(Effect.option);
        if (Option.isNone(real)) {
          // A path that names nothing, and could be one of the app's own
          // routes, gets the app.
          return path.extname(requested.value) === "" && acceptsHtml(request.headers["accept"])
            ? yield* containedTarget(path.join(root, INDEX))
            : NOT_FOUND;
        }
        if (!isWithin(realRoot, real.value)) return NOT_FOUND;
        const info = yield* fs.stat(real.value).pipe(Effect.option);
        if (Option.isNone(info)) return NOT_FOUND;
        if (info.value.type === "File") return fileTarget(real.value);
        if (info.value.type !== "Directory") return NOT_FOUND;
        if (!url.pathname.endsWith("/")) {
          // One leading slash, so the location stays on this server.
          const location = `${url.pathname.replace(/^\/+/, "/")}/${url.search}`;
          return redirectTarget(location);
        }
        return yield* containedTarget(path.join(real.value, INDEX));
      });

      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The WHATWG parser drops the query and the fragment, and resolves
        // dot segments, before anything below reads the path.
        const url = new URL(request.url, "http://localhost");
        const decoded = decodedPath(url.pathname);
        if (Option.isNone(decoded) || decoded.value.startsWith(API_PREFIX)) return notFound;
        const target = yield* resolve(request, url, decoded.value);
        switch (target._tag) {
          case "not-found":
            return notFound;
          case "redirect":
            return HttpServerResponse.redirect(target.location, { status: 301 });
          case "file": {
            const type = mediaType(target.file);
            const html = type.startsWith("text/html");
            const file = yield* HttpServerResponse.file(target.file, { contentType: type }).pipe(
              Effect.orDie,
            );
            const fileTag = file.headers["etag"];
            const response = HttpServerResponse.setHeaders(file, {
              "cache-control":
                decoded.value.startsWith(ASSETS_PREFIX) && !html ? IMMUTABLE : REVALIDATE,
              "x-content-type-options": "nosniff",
              vary: "Accept-Encoding",
              ...(fileTag === undefined ? {} : { etag: weak(fileTag) }),
              ...(html ? htmlHeaders(decoded.value) : {}),
            });
            if (!stillFresh(request, response)) return response;
            const { etag, "last-modified": lastModified } = response.headers;
            return HttpServerResponse.empty({
              status: 304,
              headers: {
                "cache-control": response.headers["cache-control"] ?? REVALIDATE,
                vary: "Accept-Encoding",
                ...(etag === undefined ? {} : { etag }),
                ...(lastModified === undefined ? {} : { "last-modified": lastModified }),
              },
            });
          }
        }
      });
      return HttpRouter.add("GET", "/*", handler.pipe(HttpMiddleware.compression()));
    }),
  );

/**
 * Whether this server serves the configured web client, decided once as it
 * starts. The routes and the admin socket's report both read this decision,
 * so a client built while the server starts never shows as served when it
 * is not.
 */
export class WebClientStatus extends Context.Service<WebClientStatus, AdminStatus["webClient"]>()(
  "@j3-bots/server/web/WebClient/WebClientStatus",
) {}

/**
 * The decision. A client configured by the operator was checked when the
 * configuration loaded; the one in this checkout is served once it is built,
 * and until then the server runs without it.
 */
export const statusLayer = Layer.effect(
  WebClientStatus,
  Effect.gen(function* () {
    const { webClient } = yield* ServerConfig;
    if (yield* isBuilt(webClient.directory)) return WebClientStatus.of("served");
    yield* Effect.logWarning("The web client is not built, so the server does not serve it", {
      directory: webClient.directory,
    });
    return WebClientStatus.of("not-built");
  }),
);

/** The configured web client's routes, when `WebClientStatus` says it is served. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { webClient } = yield* ServerConfig;
    return (yield* WebClientStatus) === "served" ? routes(webClient.directory) : Layer.empty;
  }),
);
