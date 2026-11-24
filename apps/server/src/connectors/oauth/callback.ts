// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n, resolveLocale } from "@j3-bots/i18n";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { pathOf } from "../../system/Ports.ts";
import { SIGN_IN_CALLBACK_PATH } from "@j3-bots/contracts";
import { ConnectorAuth } from "./ConnectorAuth.ts";

// Where a browser returns after a sign-in that came back to the server
// itself: its `https` public origin, or loopback when the desktop app runs it
// on the operator's computer. The query holds the authorization code and the
// sign-in's `state`, so the request log records the path alone and no trace
// records the request (`redactPath`).

/**
 * The callback's path as the request log shows it, for a request to it: its
 * query is never shown. Matched without regard to case, escapes or doubled
 * slashes, like the webhook's, so no spelling of it is logged whole.
 */
export const redactPath = (path: string): Option.Option<string> => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is matched as written.
  }
  return decoded
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .startsWith(SIGN_IN_CALLBACK_PATH)
    ? Option.some(SIGN_IN_CALLBACK_PATH)
    : Option.none();
};

/** A page with one line, in the browser's language, that nothing on it can act on. */
const page = (accept: string | undefined, signedIn: boolean) => {
  const preferred = (accept ?? "")
    .split(",")
    .map((part) => part.split(";", 1)[0]?.trim() ?? "")
    .filter((tag) => tag.length > 0);
  const language = resolveLocale(preferred);
  const { t } = createI18n(language);
  const line = t(signedIn ? "oauthCallback.signedIn" : "oauthCallback.failed");
  const html = `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t("oauthCallback.title")}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:0 16px;color-scheme:light dark}</style><p>${line}</p></html>`;
  return HttpServerResponse.text(html, {
    status: signedIn ? 200 : 400,
    contentType: "text/html; charset=utf-8",
    headers: {
      // The address holds the code: nothing on the page may load or link
      // anything that would carry it in a Referer.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
};

export const route = HttpRouter.add(
  "GET",
  `${SIGN_IN_CALLBACK_PATH}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* ConnectorAuth;
    const at = request.url.indexOf("?");
    const query = at === -1 ? "" : request.url.slice(at + 1);
    const finished = yield* auth
      .complete({ _tag: "callback", path: pathOf(request.url), query: Redacted.make(query) })
      .pipe(
        Effect.tapError((error) =>
          Effect.logInfo("A connector's sign-in did not finish").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
        Effect.option,
      );
    return page(request.headers["accept-language"], Option.isSome(finished));
  }),
);
