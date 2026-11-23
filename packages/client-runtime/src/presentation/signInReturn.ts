// SPDX-License-Identifier: AGPL-3.0-or-later
import { SIGN_IN_RETURN_MAX } from "@j3-bots/contracts";

// What an app's loopback listener makes of a request, while it catches the
// browser's return from a connector's sign-in: the desktop app's, in its main
// process, and the Android app's, whose native listener asks this of each
// request it reads. Only the return itself is taken: anything else that
// reaches the port, such as the browser asking for a favicon, is turned away
// and the listener waits on.

/** Where every sign-in returns, under a path of its authorization server's own. */
const CALLBACK_PATH = "/oauth/callback";

/** An issuer's host, as the server writes it into a callback path: a name or an address, and a port. */
const ISSUER_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;

/**
 * Whether `target` is a sign-in's return path, as the server writes one for
 * each authorization server: `/oauth/callback/<issuer host>`, then the
 * issuer's own path when it has one (`/oauth/callback/accounts.google.com`,
 * `/oauth/callback/auth.example/tenant/`). The segment after the prefix can
 * be nothing but a host, and the path is taken only as it is written: one a
 * URL parser would read otherwise (`..`, `.`, a backslash, an encoded dot) is
 * refused rather than relayed under another meaning. Which issuer's path it
 * must be is the server's to check, against the redirect it gave.
 */
const isCallbackPath = (target: string, parsed: URL): boolean => {
  const path = target.split("?", 1)[0] ?? "";
  if (path !== parsed.pathname || !path.startsWith(`${CALLBACK_PATH}/`)) return false;
  const host = path.slice(CALLBACK_PATH.length + 1).split("/", 1)[0] ?? "";
  return ISSUER_HOST.test(host);
};

/** A request to the listener, as Node hands it over. */
export interface LoopbackRequest {
  readonly method: string | undefined;
  /** The request's target: its path and query. */
  readonly url: string | undefined;
  readonly host: string | undefined;
}

/**
 * `returned`: the browser came back from a sign-in, to `url`, carrying
 * `state`. `refused`: anything else, answered with `status`.
 */
export type Arrival =
  | { readonly _tag: "returned"; readonly url: string; readonly state: string }
  | { readonly _tag: "refused"; readonly status: 400 | 404 | 405 };

/**
 * What a request to the listener on `port` is. It looks like the return only
 * when it names this listener by its own address, which a page that reached
 * the port under another name (DNS rebinding) cannot, and carries a `state`:
 * with it, a code or the provider's error. Whether it is this sign-in's state
 * is `signInCatch`'s to say.
 */
export const arrival = (request: LoopbackRequest, port: number): Arrival => {
  if (request.host !== `127.0.0.1:${port}`) return { _tag: "refused", status: 400 };
  if (request.method !== "GET") return { _tag: "refused", status: 405 };
  const target = request.url ?? "";
  const url = `http://127.0.0.1:${port}${target}`;
  const parsed = target.startsWith("/") ? URL.parse(url) : null;
  if (parsed === null || !isCallbackPath(target, parsed)) return { _tag: "refused", status: 404 };
  if (url.length > SIGN_IN_RETURN_MAX) return { _tag: "refused", status: 400 };
  const state = parsed.searchParams.get("state");
  if (state === null || state === "") return { _tag: "refused", status: 400 };
  return { _tag: "returned", url, state };
};

/** Whether two secrets are equal, in a time that depends on their lengths alone. */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
};

/** What the listener answers a request with: the landing page, or an error that says nothing. */
export type LoopbackAnswer =
  | { readonly _tag: "returned" }
  | { readonly _tag: "refused"; readonly status: 400 | 404 | 405 };

/**
 * One sign-in's catch on the listener at `port`. Only the return that carries
 * the state the server put in this sign-in (`expect`, told before the browser
 * opens it) is taken, once: it is relayed to the page and the window comes
 * forward. Anything else, a return before the state is known or with another
 * state included, is refused and changes nothing, so a process or a page that
 * reaches the port first cannot spend the sign-in.
 */
export interface SignInCatch {
  readonly expect: (state: string) => void;
  readonly answer: (request: LoopbackRequest) => LoopbackAnswer;
}

export const signInCatch = (
  port: number,
  returned: { readonly relay: (url: string) => void; readonly focus: () => void },
): SignInCatch => {
  let expected: string | null = null;
  let taken = false;
  return {
    expect: (state) => {
      expected = state;
    },
    answer: (request) => {
      const arrived = arrival(request, port);
      if (arrived._tag === "refused") return arrived;
      // The browser comes back once: a reload of the page it landed on relays nothing more.
      if (taken) return { _tag: "refused", status: 404 };
      if (expected === null || !sameSecret(arrived.state, expected)) {
        return { _tag: "refused", status: 400 };
      }
      taken = true;
      returned.relay(arrived.url);
      returned.focus();
      return { _tag: "returned" };
    },
  };
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
