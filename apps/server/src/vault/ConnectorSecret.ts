// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * A connector's id, as the vault files its secret under it. A connector's own
 * id is the one its contract gives it; the vault only needs it stable.
 */
export const ConnectorId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,99}$/),
).pipe(Schema.brand("ConnectorId"));
export type ConnectorId = typeof ConnectorId.Type;

const Secret = Schema.Redacted(Schema.String);

/**
 * The OAuth client J3 Bots signs in as at one authorization server: the one
 * registered there (dynamic registration) or the one the operator gave.
 */
const OAuthClient = Schema.Struct({
  /** The authorization server's issuer, as its metadata names it. */
  issuer: Schema.String,
  /**
   * `dynamic`: J3 Bots registered it (RFC 7591), and may register a new one
   * in its place. `operator`: the operator gave it, as for their own app,
   * and nothing replaces it.
   */
  registration: Schema.Literals(["dynamic", "operator"]),
  clientId: Schema.String,
  /** Only a confidential client has one. */
  clientSecret: Schema.NullOr(Secret),
  /** How it authenticates at the token endpoint (RFC 7591 `token_endpoint_auth_method`). */
  authMethod: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  /** The redirect URIs it is registered with. */
  redirectUris: Schema.Array(Schema.String),
});
export type OAuthClient = typeof OAuthClient.Type;

/** What a sign-in at the authorization server gave, kept to call the connector and refresh. */
const OAuthTokens = Schema.Struct({
  accessToken: Secret,
  /** Null when the server gave none; a rotated one replaces the old in the same write. */
  refreshToken: Schema.NullOr(Secret),
  /** Null when the server gave no lifetime. */
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  scopes: Schema.Array(Schema.String),
  /** The connector's canonical URI, which the tokens were issued for (RFC 8707). */
  resource: Schema.String,
  /** When the operator signed in, which a refresh keeps. */
  signedInAt: Schema.DateTimeUtc,
});
export type OAuthTokens = typeof OAuthTokens.Type;

/** A header or environment variable, with its value. */
export const NamedSecret = Schema.Struct({ name: Schema.String, value: Secret });
export type NamedSecret = typeof NamedSecret.Type;

/**
 * What a connector needs to reach its server, every value redacted. `oauth`
 * is null for a connector that signs in with no OAuth; its `tokens` are null
 * while a client is registered and no sign-in has finished. `headers` go on
 * each request to a remote server; `env` is a started server's environment.
 */
export const ConnectorSecret = Schema.Struct({
  connectorId: ConnectorId,
  /**
   * The full URL of a connector the operator added by address, which may
   * carry a key in its path or query; null for a gallery entry's, which is
   * public and kept with the connector.
   */
  address: Schema.NullOr(Secret),
  oauth: Schema.NullOr(Schema.Struct({ client: OAuthClient, tokens: Schema.NullOr(OAuthTokens) })),
  headers: Schema.Array(NamedSecret),
  env: Schema.Array(NamedSecret),
});
export type ConnectorSecret = typeof ConnectorSecret.Type;

/**
 * A connector's record id: apart from every login's (`cred_…`), so a record's
 * associated data names one record of one kind.
 */
export const connectorRecordId = (id: ConnectorId): string => `connector:${id}`;
