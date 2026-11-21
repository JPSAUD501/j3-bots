// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS } from "@j3-bots/contracts";
import type { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import { isAppUrl } from "./navigation.ts";

// What the app's scheme answers. It serves the bundled web client and nothing
// else: the page reaches the server at the server's own origin, so no request
// on the scheme ever goes to the network.

/** A request on the app's scheme, as the protocol handler receives it. */
export interface AssetRequest {
  readonly url: string;
  readonly method: string;
  readonly accept: string | null;
}

/**
 * A file of the web build, as path segments under its folder, each decoded
 * and none of them `.` or `..`; or the status a refused request gets.
 * `appShell` is set when a missing file is the client's own route, which gets
 * `index.html`.
 */
export type AssetAnswer =
  | { readonly _tag: "file"; readonly segments: ReadonlyArray<string>; readonly appShell: boolean }
  | { readonly _tag: "refused"; readonly status: 400 | 404 | 405 };

/**
 * The server's own paths. The scheme never answers them, not even with the
 * app's shell: a request for one there is a client that lost track of where
 * the server is, and must fail as such.
 */
const SERVER_PATHS = [HTTP_PATHS.server, HTTP_PATHS.attachments, HTTP_PATHS.rpc, "/api", "/hooks"];

const isServerPath = (pathname: string) =>
  SERVER_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const decodeSegment = Option.liftThrowable(decodeURIComponent);

/** Where a request on the app's scheme leads, for a page whose origin is `appOrigin`. */
export const resolveAsset = (request: AssetRequest, appOrigin: string): AssetAnswer => {
  const url = URL.parse(request.url);
  if (url === null || !isAppUrl(request.url, appOrigin)) return { _tag: "refused", status: 404 };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { _tag: "refused", status: 405 };
  }
  if (isServerPath(url.pathname)) return { _tag: "refused", status: 404 };
  const segments: Array<string> = [];
  for (const raw of url.pathname.split("/")) {
    if (raw === "") continue;
    const segment = decodeSegment(raw);
    if (
      Option.isNone(segment) ||
      segment.value === "." ||
      segment.value === ".." ||
      /[/\\\0]/.test(segment.value)
    ) {
      return { _tag: "refused", status: 400 };
    }
    segments.push(segment.value);
  }
  const last = segments.at(-1) ?? "";
  const extensionless = !last.includes(".");
  const wantsHtml = request.accept?.includes("text/html") ?? false;
  return { _tag: "file", segments, appShell: extensionless && wantsHtml };
};

/** Each inline script of `html` (one without `src`), as the CSP `'sha256-…'` source that allows it. */
export const inlineScriptSources = async (html: string): Promise<ReadonlyArray<string>> => {
  const bodies = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1] ?? "",
  );
  return Promise.all(
    bodies.map(async (body) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      return `'sha256-${Base64.encode(new Uint8Array(digest))}'`;
    }),
  );
};

/**
 * The page's content security policy. Scripts come only from the build and
 * the inline scripts it ships, and the page may connect only to itself and to
 * the server the operator named, over HTTP and its WebSocket.
 */
export const contentSecurityPolicy = (
  server: ServerOrigin | null,
  scriptSources: ReadonlyArray<string>,
): string => {
  const connect = ["'self'"];
  if (server !== null) {
    const socket = new URL(server);
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    connect.push(server, socket.origin);
  }
  return [
    "default-src 'none'",
    `script-src 'self' ${scriptSources.join(" ")}`.trim(),
    // React and the UI kit set style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "manifest-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
};
