// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * A connector's id, as the secrets file its secret under it. A connector's own
 * id is the one its contract gives it; the secrets only need it stable.
 */
export const ConnectorId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,99}$/),
).pipe(Schema.brand("ConnectorId"));
export type ConnectorId = typeof ConnectorId.Type;

const Secret = Schema.Redacted(Schema.String);

/**
 * The OAuth client J3 Bots signs in as at one authorization server: the
 * server's own client metadata document, the one registered there (dynamic
 * registration) or the one the operator gave.
 */
const OAuthClient = Schema.Struct({
  /** The authorization server's issuer, as its metadata names it. */
  issuer: Schema.String,
  /**
   * `metadata`: its id is the address of the server's client metadata
   * document, which the authorization server reads. `dynamic`: J3 Bots
   * registered it (RFC 7591). Either may be replaced by a new one.
   * `operator`: the operator gave it, as for their own app, and nothing
   * replaces it.
   */
  registration: Schema.Literals(["metadata", "dynamic", "operator"]),
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
 * each request to a remote server. `command` is a started server's command
 * line, null for any other: its program and its arguments, which can carry a
 * key; `env` is its environment. The process starts from this record alone,
 * which one write replaces whole, so a start never mixes a command line with
 * another's environment.
 */
export const ConnectorSecret = Schema.Struct({
  connectorId: ConnectorId,
  /**
   * The full URL of the connector's server, which may carry a key in its
   * path or query: the one the operator typed, or the one a gallery entry's
   * form gave. Null only for a server started by command.
   */
  address: Schema.NullOr(Secret),
  oauth: Schema.NullOr(Schema.Struct({ client: OAuthClient, tokens: Schema.NullOr(OAuthTokens) })),
  headers: Schema.Array(NamedSecret),
  command: Schema.NullOr(Schema.Struct({ program: Schema.String, args: Schema.Array(Secret) })),
  env: Schema.Array(NamedSecret),
  /**
   * The value of each secret field of a gallery entry's form, named by the
   * field's key. The address and headers hold them rendered, as the key in
   * `Bearer {key}`; these are never sent as they are, only taken out of what
   * the connector's server says, and kept out of a sign-in's address.
   */
  formSecrets: Schema.Array(NamedSecret),
  /**
   * The value of each other field of a gallery entry's headers, by key:
   * not a secret, kept beside them so a header made of several fields is
   * rendered again whole when one of them is given anew.
   */
  formValues: Schema.Array(NamedSecret),
});
export type ConnectorSecret = typeof ConnectorSecret.Type;

/**
 * A connector's record id: apart from every login's (`cred_…`), so a record's
 * associated data names one record of one kind.
 */
export const connectorRecordId = (id: ConnectorId): string => `connector:${id}`;
