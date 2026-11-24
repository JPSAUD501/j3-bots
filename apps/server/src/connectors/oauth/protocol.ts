// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The parts of the MCP authorization specification (revision 2025-11-25) and
// the RFCs it names that need no network: reading a `WWW-Authenticate`
// challenge, the discovery addresses in the order the specification gives,
// the metadata documents, and the canonical address a token is issued for.
// The calls themselves are in `endpoints.ts`.

/** What a `Bearer` challenge (RFC 6750 §3, RFC 9728 §5.1) says, for discovery. */
export interface BearerChallenge {
  /** Where the protected resource's metadata is (RFC 9728 §5.1). */
  readonly resourceMetadata: Option.Option<string>;
  /** The scopes the server says a request needs, space separated. */
  readonly scope: Option.Option<string>;
  readonly error: Option.Option<string>;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** An item's first token, and the `=` after it when the item is a parameter. */
const LEADING_TOKEN = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(\s*=)?/;

/**
 * Splits a header's value at the commas that are outside quoted strings
 * (RFC 9110 §5.6.1, §5.6.4).
 */
const splitList = (value: string): ReadonlyArray<string> => {
  const items: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (quoted && char === "\\" && index + 1 < value.length) {
      current += char + value.charAt(index + 1);
      index++;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === "," && !quoted) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
};

/** An auth-param's value: a token, or a quoted string with its escapes undone. */
const paramValue = (raw: string): Option.Option<string> => {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return Option.none();
    return Option.some(value.slice(1, -1).replace(/\\(.)/g, "$1"));
  }
  return TOKEN.test(value) ? Option.some(value) : Option.none();
};

/**
 * The `Bearer` challenge among a `WWW-Authenticate` header's challenges, or
 * none when it has no such challenge. A header may carry several schemes
 * (`Basic realm="x", Bearer scope="y"`); only Bearer's parameters count, and
 * a parameter that cannot be read is left out rather than guessed.
 */
export const parseBearerChallenge = (header: string): Option.Option<BearerChallenge> => {
  const params = new Map<string, string>();
  let inBearer = false;
  let found = false;
  for (const item of splitList(header)) {
    const head = LEADING_TOKEN.exec(item);
    if (head === null) continue;
    const [whole, token = "", equals] = head;
    let param = item;
    // A new challenge starts with its scheme: a token not followed by `=`.
    if (equals === undefined) {
      inBearer = token.toLowerCase() === "bearer";
      found ||= inBearer;
      param = item.slice(whole.length).trim();
      if (param.length === 0) continue;
    }
    if (!inBearer) continue;
    const at = param.indexOf("=");
    if (at <= 0) continue;
    const name = param.slice(0, at).trim().toLowerCase();
    const value = paramValue(param.slice(at + 1));
    if (TOKEN.test(name) && Option.isSome(value) && !params.has(name))
      params.set(name, value.value);
  }
  if (!found) return Option.none();
  return Option.some({
    resourceMetadata: Option.fromUndefinedOr(params.get("resource_metadata")),
    scope: Option.fromUndefinedOr(params.get("scope")),
    error: Option.fromUndefinedOr(params.get("error")),
  });
};

/** A URL J3 Bots may call during a sign-in: `https`, with no user name or password in it. */
export const secureUrl = (value: string): Option.Option<URL> => {
  if (!URL.canParse(value)) return Option.none();
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return Option.none();
  }
  return Option.some(url);
};

/** A path without its trailing `/`, so `/mcp/` and `/mcp` name one resource. */
const trimSlash = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);

/**
 * The MCP server's canonical URI (RFC 8707 §2, the MCP specification's
 * "Canonical Server URI"): scheme and host in lower case, which `URL` already
 * does, no fragment, no query, and no trailing `/`.
 */
export const canonicalResource = (server: URL): string =>
  `${server.protocol}//${server.host}${trimSlash(server.pathname)}`;

/**
 * Whether the resource a metadata document names covers the MCP server at
 * `server`: the same origin, and the server's path is the resource's or below
 * it, segment by segment. The MCP specification allows a server's metadata to
 * name the resource it belongs to (`https://example.com` for
 * `https://example.com/mcp`); a token for that resource may go to this server,
 * and to no other origin.
 */
export const resourceCovers = (resource: string, server: URL): boolean => {
  if (!URL.canParse(resource)) return false;
  const named = new URL(resource);
  if (named.hash !== "" || named.search !== "") return false;
  if (named.protocol !== server.protocol || named.host !== server.host) return false;
  const base = trimSlash(named.pathname);
  const path = trimSlash(server.pathname);
  return path === base || path.startsWith(`${base}/`);
};

/**
 * Where to look for the protected resource metadata when no challenge named
 * it, in the specification's order: the address with the server's path
 * (RFC 9728 §3.1), then the root.
 */
export const resourceMetadataUrls = (server: URL): ReadonlyArray<string> => {
  const root = `${server.protocol}//${server.host}/.well-known/oauth-protected-resource`;
  const path = trimSlash(server.pathname);
  return path === "" ? [root] : [`${root}${path}`, root];
};

/**
 * Where an authorization server's metadata may be, in the specification's
 * order: OAuth 2.0 Authorization Server Metadata (RFC 8414 §3.1) with the
 * issuer's path inserted, then OpenID Connect Discovery with it inserted, then
 * OpenID Connect Discovery with it appended. An issuer without a path has the
 * first two only.
 */
export const authorizationServerMetadataUrls = (issuer: URL): ReadonlyArray<string> => {
  const origin = `${issuer.protocol}//${issuer.host}`;
  const path = trimSlash(issuer.pathname);
  if (path === "") {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
};

/**
 * Whether two issuer identifiers are the same: identical, character for
 * character, as RFC 8414 §3.3 and RFC 9207 §2.4 compare them. An issuer that
 * differs by a trailing `/` is another issuer.
 */
export const sameIssuer = (a: string, b: string): boolean => a === b;

/** An address on this machine's IPv4 loopback, over plain HTTP, as a native app's redirect is. */
const loopback = (url: URL) => url.protocol === "http:" && url.hostname === "127.0.0.1";

/**
 * Whether a client registered with `registered` may return to `requested`:
 * the same address, or, on loopback, the same address on any port. An
 * authorization server lets a native app's loopback redirect name any port
 * (RFC 8252 §7.3, which OAuth 2.1 makes a requirement), so a client J3 Bots
 * registered for one relayed sign-in serves the next, on its new port, and a
 * pasted one, which names none.
 */
export const redirectMatches = (registered: string, requested: string): boolean => {
  if (registered === requested) return true;
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return (
    loopback(a) &&
    loopback(b) &&
    a.pathname === b.pathname &&
    a.search === "" &&
    b.search === "" &&
    a.hash === "" &&
    b.hash === ""
  );
};

const Strings = Schema.Array(Schema.String);

/** Protected resource metadata (RFC 9728 §2), the fields a sign-in reads. */
export const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.optionalKey(Strings),
  scopes_supported: Schema.optionalKey(Strings),
});
export type ProtectedResourceMetadata = typeof ProtectedResourceMetadata.Type;

/**
 * Authorization server metadata (RFC 8414 §2, and OpenID Connect Discovery's
 * document, which has the same fields), the fields a sign-in reads.
 */
export const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint: Schema.optionalKey(Schema.String),
  scopes_supported: Schema.optionalKey(Strings),
  response_types_supported: Schema.optionalKey(Strings),
  code_challenge_methods_supported: Schema.optionalKey(Strings),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Strings),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});
export type AuthorizationServerMetadata = typeof AuthorizationServerMetadata.Type;

/** How a client authenticates at the token endpoint (RFC 7591 §2). */
export const AuthMethod = Schema.Literals(["none", "client_secret_post", "client_secret_basic"]);
export type AuthMethod = typeof AuthMethod.Type;

/**
 * The method to register with: none when the server takes public clients,
 * which PKCE protects, else a secret sent in the body, else in the header.
 * RFC 8414 §2 makes `client_secret_basic` the default of a server that lists
 * none.
 */
export const chooseAuthMethod = (
  metadata: AuthorizationServerMetadata,
): Option.Option<AuthMethod> => {
  const supported = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const preferred: ReadonlyArray<AuthMethod> = [
    "none",
    "client_secret_post",
    "client_secret_basic",
  ];
  return Option.fromUndefinedOr(preferred.find((method) => supported.includes(method)));
};

/** A dynamic client registration's answer (RFC 7591 §3.2.1), the fields J3 Bots keeps. */
export const RegistrationResponse = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.optionalKey(Strings),
});
export type RegistrationResponse = typeof RegistrationResponse.Type;

/**
 * A token endpoint's success (RFC 6749 §5.1). Some servers send `expires_in`
 * as a string of digits; both are read.
 */
export const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String,
  expires_in: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.FiniteFromString])),
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  scope: Schema.optionalKey(Schema.String),
});
export type TokenResponse = typeof TokenResponse.Type;

/** A token endpoint's refusal (RFC 6749 §5.2): only its code is read, never its description. */
export const TokenError = Schema.Struct({ error: Schema.String });

/** The scopes of a space-separated `scope` value. */
export const scopesOf = (scope: string): ReadonlyArray<string> =>
  scope.split(" ").filter((item) => item.length > 0);
