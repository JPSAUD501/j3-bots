// SPDX-License-Identifier: AGPL-3.0-or-later
import { layerGuardedHttpClient } from "@j3-bots/connectors";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readText } from "../../body.ts";
import { CLIENT_NAME, ClientMetadataDocument } from "./clientMetadata.ts";
import { OAuthFailure } from "./errors.ts";
import {
  type AuthMethod,
  AuthorizationServerMetadata,
  authorizationServerMetadataUrls,
  type BearerChallenge,
  parseBearerChallenge,
  ProtectedResourceMetadata,
  redirectMatches,
  RegistrationResponse,
  sameIssuer,
  secureUrl,
  TokenError,
  TokenResponse,
} from "./protocol.ts";

// The calls a sign-in makes: to the MCP server, for its challenge; to the
// metadata documents; to the registration, token and revocation endpoints.
// Every one goes through `OAuthHttp`, which refuses what a remote server could
// point J3 Bots at inside the operator's network, and follows no redirect.
// Nothing here logs; a failure says only its reason.

/**
 * The HTTP client sign-ins use: one that reaches public `https` addresses
 * only, checked after name resolution, and never follows a redirect. The
 * server provides it from the connectors' guarded client; a test, from a fake
 * authorization server.
 */
export class OAuthHttp extends Context.Service<OAuthHttp, HttpClient.HttpClient>()(
  "@j3-bots/server/connectors/oauth/endpoints/OAuthHttp",
) {}

/**
 * The connectors' guarded client, as sign-ins use it: public `https` only,
 * never the operator's own network, and no redirect followed.
 */
export const layer = Layer.effect(OAuthHttp, Effect.service(HttpClient.HttpClient)).pipe(
  Layer.provide(
    layerGuardedHttpClient({ loopback: "refuse", privateNetwork: "refuse", redirects: "refuse" }),
  ),
);

/** Every metadata document and endpoint answer is small: more is refused unread. */
const ANSWER_LIMIT = 64 * 1024;

/** How long one call may take, from connecting to the last byte of its answer read. */
const CALL_TIMEOUT = Duration.seconds(15);

/**
 * Sends `request` and reads what `read` needs of its answer, all within the
 * call's time: an answer whose body stalls is cut off like one that never
 * comes, and a body left unread is released when the call ends. No span is
 * recorded: the address can be the connector's own, which may hold a key.
 */
const call = Effect.fn("OAuth.call")(
  function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, OAuthFailure>,
  ) {
    const client = HttpClient.withScope(yield* OAuthHttp);
    return yield* client.execute(request).pipe(
      Effect.mapError(() => new OAuthFailure({ reason: "unreachable" })),
      Effect.flatMap(read),
    );
  },
  Effect.timeoutOrElse({
    duration: CALL_TIMEOUT,
    orElse: () => Effect.fail(new OAuthFailure({ reason: "unreachable" })),
  }),
  Effect.scoped,
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
);

/** The answer's body as `schema`, read within the limit. */
const decode = <A>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<A, unknown>,
) =>
  readText(response, ANSWER_LIMIT).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError(() => new OAuthFailure({ reason: "invalid-response" })),
  );

/**
 * The MCP server's answer to a request without a token: its `Bearer`
 * challenge, when it answers 401 with one (MCP authorization, "Protected
 * Resource Metadata Discovery"). The request is the `initialize` a client
 * starts with; its answer is not read.
 */
export const challenge = (server: URL) =>
  call(
    HttpClientRequest.post(server).pipe(
      HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: "0" },
        },
      }),
    ),
    (response) => {
      const header = response.headers["www-authenticate"];
      return Effect.succeed(
        response.status === 401 && header !== undefined
          ? parseBearerChallenge(header)
          : Option.none<BearerChallenge>(),
      );
    },
  );

/**
 * A metadata document at `url`: none when the server has none there (a 4xx,
 * or an answer that is no such document, as a page a catch-all route
 * serves), unreachable when it did not answer or failed (a 5xx).
 */
const metadata = <A>(url: string, schema: Schema.Codec<A, unknown>) =>
  call(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson), (response) => {
    if (response.status >= 400 && response.status < 500) return Effect.succeed(Option.none<A>());
    if (response.status !== 200) return Effect.fail(new OAuthFailure({ reason: "unreachable" }));
    return decode(response, schema).pipe(Effect.option);
  });

/**
 * Each document found at `urls`, in their order, until `use` answers one:
 * an address without one, or that fails, leaves the next to try, as the
 * MCP specification asks. When none has one, a failure says so before the
 * absence does, since the document may be where the server failed.
 */
const firstDocument = Effect.fn("OAuth.firstDocument")(function* <A, B>(
  urls: ReadonlyArray<string>,
  schema: Schema.Codec<A, unknown>,
  use: (document: A) => Effect.Effect<B, OAuthFailure>,
) {
  let failed: Option.Option<OAuthFailure> = Option.none();
  for (const url of urls) {
    const found = yield* Effect.result(metadata(url, schema));
    if (found._tag === "Failure") {
      failed = Option.orElse(failed, () => Option.some(found.failure));
      continue;
    }
    if (Option.isSome(found.success)) return yield* use(found.success.value);
  }
  return yield* Option.getOrElse(failed, () => new OAuthFailure({ reason: "no-metadata" }));
});

/** The protected resource metadata at the first of `urls` that has one. */
export const resourceMetadata = (urls: ReadonlyArray<string>) =>
  firstDocument(urls, ProtectedResourceMetadata, Effect.succeed);

/**
 * The authorization server's metadata, from the first address in the
 * specification's order that has it, checked: it names the issuer it was
 * looked up for, every endpoint is `https`, and it offers PKCE with `S256`,
 * without which the MCP specification forbids going on.
 */
export const authorizationServerMetadata = Effect.fn("OAuth.authorizationServerMetadata")(
  function* (issuer: string) {
    const at = secureUrl(issuer);
    if (Option.isNone(at)) return yield* new OAuthFailure({ reason: "insecure-endpoint" });
    return yield* firstDocument(
      authorizationServerMetadataUrls(at.value),
      AuthorizationServerMetadata,
      // A document found is the server's answer: one that fails a check ends discovery.
      Effect.fnUntraced(function* (document) {
        if (!sameIssuer(document.issuer, issuer)) {
          return yield* new OAuthFailure({ reason: "issuer-mismatch" });
        }
        const endpoints = [
          document.authorization_endpoint,
          document.token_endpoint,
          ...(document.registration_endpoint === undefined ? [] : [document.registration_endpoint]),
          ...(document.revocation_endpoint === undefined ? [] : [document.revocation_endpoint]),
        ];
        if (endpoints.some((endpoint) => Option.isNone(secureUrl(endpoint)))) {
          return yield* new OAuthFailure({ reason: "insecure-endpoint" });
        }
        if (!(document.code_challenge_methods_supported ?? []).includes("S256")) {
          return yield* new OAuthFailure({ reason: "pkce-unsupported" });
        }
        return document;
      }),
    );
  },
);

/** A client registered by J3 Bots, as the server answered. */
interface Registered {
  readonly clientId: string;
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>;
  readonly authMethod: AuthMethod;
  readonly redirectUris: ReadonlyArray<string>;
}

/**
 * The server's own client metadata document at `url`, read as an
 * authorization server on the internet reads it: through the client
 * sign-ins use, which reaches public addresses only. Read, and naming itself
 * and `redirectUri` (a loopback one at any port, as a relayed sign-in's
 * has), it can be J3 Bots' client id there; an address only the
 * operator's network reaches is refused before anything is asked of it.
 */
export const clientDocument = Effect.fn("OAuth.clientDocument")(function* (
  url: string,
  redirectUri: string,
) {
  const document = yield* call(
    HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
    (response) =>
      response.status === 200
        ? decode(response, ClientMetadataDocument)
        : Effect.fail(new OAuthFailure({ reason: "invalid-response" })),
  );
  if (
    document.client_id !== url ||
    !document.redirect_uris.some((listed) => redirectMatches(listed, redirectUri))
  ) {
    return yield* new OAuthFailure({ reason: "invalid-response" });
  }
  return document;
});

/**
 * Registers J3 Bots as a client (RFC 7591), for the code grant with refresh,
 * with `redirectUri` and the authentication method asked for. A server may
 * answer another method; a client that needs a secret it was not given, or
 * that is not registered for `redirectUri`, cannot sign in, and is refused.
 * It says it is a native app when it returns to loopback, and a web app when
 * it returns to the server's own `https` address (OpenID Connect Dynamic
 * Client Registration's `application_type`, which MCP asks for from
 * 2026-07-28): a provider that checks redirects against it takes either.
 */
export const register = Effect.fn("OAuth.register")(function* (input: {
  readonly endpoint: string;
  readonly redirectUri: string;
  readonly authMethod: AuthMethod;
  readonly scopes: ReadonlyArray<string>;
}) {
  const answer = yield* call(
    HttpClientRequest.post(input.endpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({
        client_name: CLIENT_NAME,
        application_type: new URL(input.redirectUri).protocol === "https:" ? "web" : "native",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: input.authMethod,
        ...(input.scopes.length === 0 ? {} : { scope: input.scopes.join(" ") }),
      }),
    ),
    (response) =>
      response.status === 201 || response.status === 200
        ? decode(response, RegistrationResponse)
        : Effect.fail(new OAuthFailure({ reason: "registration-refused" })),
  );
  const method = Schema.decodeUnknownOption(
    Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  )(answer.token_endpoint_auth_method ?? input.authMethod);
  const secret = Option.fromUndefinedOr(answer.client_secret).pipe(
    Option.filter((value) => value.length > 0),
    Option.map(Redacted.make),
  );
  const redirectUris = answer.redirect_uris ?? [input.redirectUri];
  if (
    Option.isNone(method) ||
    (method.value !== "none" && Option.isNone(secret)) ||
    !redirectUris.includes(input.redirectUri)
  ) {
    return yield* new OAuthFailure({ reason: "registration-refused" });
  }
  return {
    clientId: answer.client_id,
    clientSecret: secret,
    authMethod: method.value,
    redirectUris,
  } satisfies Registered;
});

/** The client a token request authenticates as. */
export interface TokenClient {
  readonly clientId: string;
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>;
  readonly authMethod: AuthMethod;
}

/**
 * `params` with the client's authentication (RFC 6749 §2.3.1): its id in the
 * body for a public client, its secret in the body or in a Basic header, with
 * both parts form-encoded first, as §2.3.1 asks.
 */
const authenticated = (
  endpoint: string,
  client: TokenClient,
  params: ReadonlyArray<readonly [string, string]>,
) => {
  const secret = Option.map(client.clientSecret, Redacted.value).pipe(Option.getOrElse(() => ""));
  const body: Array<readonly [string, string]> = [...params];
  if (client.authMethod !== "client_secret_basic") body.push(["client_id", client.clientId]);
  if (client.authMethod === "client_secret_post") body.push(["client_secret", secret]);
  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyUrlParams(body),
  );
  return client.authMethod === "client_secret_basic"
    ? request.pipe(
        HttpClientRequest.basicAuth(
          encodeURIComponent(client.clientId),
          encodeURIComponent(secret),
        ),
      )
    : request;
};

/** What a token endpoint gave. */
export interface Tokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken: Option.Option<Redacted.Redacted<string>>;
  readonly expiresIn: Option.Option<Duration.Duration>;
  readonly scope: Option.Option<string>;
}

/**
 * A token request (RFC 6749 §4.1.3, §6), with the resource the token is for
 * (RFC 8707 §2.2). Only a Bearer token is taken. A refusal says only its
 * kind: `invalid-grant` when the code or refresh token is no longer good,
 * `invalid-client` when the client itself is refused.
 */
export const requestTokens = Effect.fn("OAuth.requestTokens")(function* (input: {
  readonly endpoint: string;
  readonly client: TokenClient;
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly resource: string;
}) {
  const answer = yield* call(
    authenticated(input.endpoint, input.client, [...input.params, ["resource", input.resource]]),
    Effect.fnUntraced(function* (response) {
      if (response.status === 200) return yield* decode(response, TokenResponse);
      if (response.status >= 500) return yield* new OAuthFailure({ reason: "unreachable" });
      const refusal = yield* decode(response, TokenError).pipe(Effect.option);
      const code = Option.map(refusal, ({ error }) => error).pipe(Option.getOrElse(() => ""));
      return yield* new OAuthFailure({
        reason:
          code === "invalid_grant"
            ? "invalid-grant"
            : code === "invalid_client" || code === "unauthorized_client"
              ? "invalid-client"
              : "token-refused",
      });
    }),
  );
  if (answer.token_type.toLowerCase() !== "bearer") {
    return yield* new OAuthFailure({ reason: "token-refused" });
  }
  return {
    accessToken: Redacted.make(answer.access_token),
    refreshToken: Option.fromUndefinedOr(answer.refresh_token).pipe(Option.map(Redacted.make)),
    // Zero is a token that expires as it comes; a negative lifetime says nothing.
    expiresIn: Option.fromUndefinedOr(answer.expires_in).pipe(
      Option.filter((seconds) => seconds >= 0),
      Option.map(Duration.seconds),
    ),
    scope: Option.fromUndefinedOr(answer.scope),
  } satisfies Tokens;
});

/**
 * Asks the server to revoke `token` (RFC 7009 §2.1). Revoking a refresh token
 * ends the grant at servers that follow §2.1's advice; the access token is
 * revoked too, for those that don't. An error is not the operator's problem:
 * the tokens are deleted either way.
 */
export const revoke = (input: {
  readonly endpoint: string;
  readonly client: TokenClient;
  readonly token: Redacted.Redacted<string>;
  readonly hint: "access_token" | "refresh_token";
}) =>
  call(
    authenticated(input.endpoint, input.client, [
      ["token", Redacted.value(input.token)],
      ["token_type_hint", input.hint],
    ]),
    (response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new OAuthFailure({ reason: "unreachable" })),
  );
