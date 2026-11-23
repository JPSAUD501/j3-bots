// SPDX-License-Identifier: AGPL-3.0-or-later
import { SIGN_IN_RETURN_MAX } from "@j3-bots/desktop-bridge";

// What the app's loopback listener makes of a request, while it catches the
// browser's return from a connector's sign-in (`signInRelay.ts`). Only the
// return itself is taken: anything else that reaches the port, such as the
// browser asking for a favicon, is turned away and the listener waits on.

/** The path the browser comes back to, as the server names it in the sign-in it starts. */
const CALLBACK_PATH = "/oauth/callback";

/** A request to the listener, as Node hands it over. */
export interface LoopbackRequest {
  readonly method: string | undefined;
  /** The request's target: its path and query. */
  readonly url: string | undefined;
  readonly host: string | undefined;
}

/**
 * `returned`: the browser came back from the sign-in, to `url`, and the
 * listener's work is done. `refused`: anything else, answered with `status`.
 */
export type Arrival =
  | { readonly _tag: "returned"; readonly url: string }
  | { readonly _tag: "refused"; readonly status: 400 | 404 | 405 };

/**
 * What a request to the listener on `port` is. It is the return only when it
 * names this listener by its own address, which a page that reached the port
 * under another name (DNS rebinding) cannot, and carries the `state` the
 * server's sign-in put in it: with it, a code or the provider's error.
 */
export const arrival = (request: LoopbackRequest, port: number): Arrival => {
  if (request.host !== `127.0.0.1:${port}`) return { _tag: "refused", status: 400 };
  if (request.method !== "GET") return { _tag: "refused", status: 405 };
  const target = request.url ?? "";
  const url = `http://127.0.0.1:${port}${target}`;
  const parsed = target.startsWith("/") ? URL.parse(url) : null;
  if (parsed === null || parsed.pathname !== CALLBACK_PATH) return { _tag: "refused", status: 404 };
  if (url.length > SIGN_IN_RETURN_MAX) return { _tag: "refused", status: 400 };
  const state = parsed.searchParams.get("state");
  if (state === null || state === "") return { _tag: "refused", status: 400 };
  return { _tag: "returned", url };
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * The page the browser shows once it is back: that the app takes it from
 * here. No script, nothing loaded from elsewhere, in the system's theme.
 */
export const landingPage = (text: {
  readonly language: string;
  readonly title: string;
  readonly body: string;
}): string => `<!doctype html>
<html lang="${escapeHtml(text.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(text.title)}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #fafafa; color: #18181b; }
main { max-width: 28rem; padding: 2rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0; color: #52525b; }
@media (prefers-color-scheme: dark) { body { background: #000; color: #fafafa; } p { color: #a1a1aa; } }
</style>
</head>
<body><main><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.body)}</p></main></body>
</html>
`;

/** The headers every answer of the listener carries: nothing runs, nothing is kept, nothing is told. */
export const LOOPBACK_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
