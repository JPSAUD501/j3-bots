// SPDX-License-Identifier: AGPL-3.0-or-later
import { signInCallbackPath } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ServerConfig } from "../../config.ts";
import { pathOf } from "../../system/Ports.ts";

// J3 Bots' OAuth client, described by a document at the server's own
// `https` address (OAuth Client ID Metadata Document, draft 00, which MCP
// authorization prefers to dynamic registration from 2026-07-28): the
// document's address is the client's id, and an authorization server that
// takes such ids reads it there. There is one per authorization server, since
// the redirects it lists are that server's callbacks.

/** Where the documents are: one per authorization server, under its host and path. */
export const CLIENT_METADATA_PATH = "/oauth/client";

/** The client's name, which a provider shows on its consent page. */
export const CLIENT_NAME = "J3 Bots";

/** The document's address for sign-ins at `issuer`, at the server's `origin`: the client's id. */
export const clientMetadataUrl = (origin: string, issuer: URL): string =>
  `${origin}${CLIENT_METADATA_PATH}/${issuer.host}${issuer.pathname === "/" ? "" : issuer.pathname}`;

/**
 * The document for sign-ins at `issuer`: a public client, which PKCE
 * protects, that returns to the server's own callback for that issuer or to
 * the same path on loopback, at any port (RFC 8252 §7.3).
 */
export const clientMetadataDocument = (origin: string, issuer: URL) => {
  const callback = signInCallbackPath(issuer);
  return {
    client_id: clientMetadataUrl(origin, issuer),
    client_name: CLIENT_NAME,
    redirect_uris: [`${origin}${callback}`, `http://127.0.0.1${callback}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
};

/** The fields of a document a sign-in checks before it names the document as its client. */
export const ClientMetadataDocument = Schema.Struct({
  client_id: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.Literal("none"),
});

/**
 * The issuer a document's path names, as `clientMetadataUrl` writes it; none
 * for a path it never writes, so each document has one address.
 */
const issuerOf = (path: string): Option.Option<URL> => {
  const named = path.slice(CLIENT_METADATA_PATH.length + 1);
  if (named === "" || !URL.canParse(`https://${named}`)) return Option.none();
  const issuer = new URL(`https://${named}`);
  return clientMetadataUrl("", issuer) === path ? Option.some(issuer) : Option.none();
};

/**
 * Serves the documents at the server's public origin, the only address an
 * authorization server on the internet can read them at; without one, there
 * are none. They hold nothing secret, and any authorization server may read
 * them: what they list are J3 Bots' own callbacks, which finish only a
 * sign-in the server began.
 */
export const route = HttpRouter.add(
  "GET",
  `${CLIENT_METADATA_PATH}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { publicOrigin } = yield* ServerConfig;
    const issuer = issuerOf(pathOf(request.url));
    if (Option.isNone(publicOrigin) || Option.isNone(issuer)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    return yield* HttpServerResponse.json(
      clientMetadataDocument(publicOrigin.value, issuer.value),
      { headers: { "cache-control": "public, max-age=3600" } },
    );
  }).pipe(Effect.orDie),
);
