// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A private key in PEM or JWK form, a signature made with it, and a digest of the credentials come only from node:crypto.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import type { ServiceCredentials } from "../../secrets/ConnectorSecret.ts";
import * as Endpoints from "./endpoints.ts";
import { OAuthFailure } from "./errors.ts";
import { type AuthorizationServerMetadata, grantsOf } from "./protocol.ts";

/**
 * Signing in as a service (the MCP OAuth client credentials extension,
 * `io.modelcontextprotocol/oauth-client-credentials`): a client the operator
 * registered at the service gets a token for the connector's server with the
 * client credentials grant (RFC 6749 §4.4), proving itself with its secret
 * or with an assertion it signs with its private key (RFC 7523 §2.2).
 */

/** The algorithms a client's assertion is signed with, as JOSE names them (RFC 7518 §3.1, RFC 8037). */
type SigningAlgorithm = "RS256" | "PS256" | "ES256" | "ES384" | "ES512" | "EdDSA";

/** How long an assertion is good for: enough to reach the token endpoint, and no more. */
const ASSERTION_LIFETIME_SECONDS = 300;

/** The shortest RSA key a signature is made with (NIST SP 800-131A). */
const MIN_RSA_BITS = 2048;

/** A private key as JWK (RFC 7517), with the members a private key of the kinds taken can have. */
const PrivateJwk = Schema.Struct({
  kty: Schema.String,
  crv: Schema.optionalKey(Schema.String),
  d: Schema.String,
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
});
const decodeJwk = Schema.decodeUnknownOption(Schema.fromJsonString(PrivateJwk));

const PEM = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/u;

/**
 * A PEM block as a pasted one may have come: on one line, its line breaks
 * written as `\n`, or with spaces in place of them. Its body is wrapped at
 * 64 characters again, as RFC 7468 §2 writes it.
 */
const pemOf = (text: string): Option.Option<string> => {
  const found = PEM.exec(text.replaceAll("\\n", "\n"));
  if (found === null) return Option.none();
  const label = found[1] ?? "";
  const body = (found[2] ?? "").replace(/\s+/gu, "");
  const lines = body.match(/.{1,64}/gu) ?? [];
  return Option.some([`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n"));
};

const createKey = Option.liftThrowable(
  (input: NodeCrypto.PrivateKeyInput | NodeCrypto.JsonWebKeyInput) =>
    NodeCrypto.createPrivateKey(input),
);

/** The algorithms a private key signs with, strongest-supported first; none for a key not taken. */
const algorithmsOf = (key: NodeCrypto.KeyObject): ReadonlyArray<SigningAlgorithm> => {
  const details = key.asymmetricKeyDetails;
  switch (key.asymmetricKeyType) {
    case "rsa":
      return (details?.modulusLength ?? 0) >= MIN_RSA_BITS ? ["RS256", "PS256"] : [];
    case "rsa-pss":
      return (details?.modulusLength ?? 0) >= MIN_RSA_BITS ? ["PS256"] : [];
    case "ec":
      switch (details?.namedCurve) {
        case "prime256v1":
          return ["ES256"];
        case "secp384r1":
          return ["ES384"];
        case "secp521r1":
          return ["ES512"];
        default:
          return [];
      }
    case "ed25519":
      return ["EdDSA"];
    default:
      return [];
  }
};

/** A private key a client's assertion is signed with, and the algorithms it signs with. */
export interface SigningKey {
  readonly key: NodeCrypto.KeyObject;
  readonly algorithms: ReadonlyArray<SigningAlgorithm>;
}

/**
 * The private key in `text`, as a person pastes it: PEM (PKCS #8, PKCS #1
 * or SEC 1), whole or on one line, or a JWK. None for anything else, a
 * public key, an encrypted one, or one of a kind no assertion is signed with.
 */
export const signingKeyOf = (text: string): Option.Option<SigningKey> => {
  const trimmed = text.trim();
  const key = trimmed.startsWith("{")
    ? Option.flatMap(decodeJwk(trimmed), (jwk) => createKey({ key: jwk, format: "jwk" }))
    : Option.flatMap(pemOf(trimmed), (pem) => createKey({ key: pem, format: "pem" }));
  return Option.flatMap(key, (found) => {
    const algorithms = algorithmsOf(found);
    return algorithms.length === 0 ? Option.none() : Option.some({ key: found, algorithms });
  });
};

const base64url = (text: string) => Base64Url.encode(new TextEncoder().encode(text));

/** The signature of `data` with `key`, as JWS writes one for `algorithm` (RFC 7518 §3). */
const signatureOf = (
  algorithm: SigningAlgorithm,
  key: NodeCrypto.KeyObject,
  data: Uint8Array,
): Uint8Array => {
  switch (algorithm) {
    case "RS256":
      return NodeCrypto.sign("sha256", data, key);
    case "PS256":
      return NodeCrypto.sign("sha256", data, {
        key,
        padding: NodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
    case "ES256":
      return NodeCrypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
    case "ES384":
      return NodeCrypto.sign("sha384", data, { key, dsaEncoding: "ieee-p1363" });
    case "ES512":
      return NodeCrypto.sign("sha512", data, { key, dsaEncoding: "ieee-p1363" });
    case "EdDSA":
      return NodeCrypto.sign(null, data, key);
  }
};

/**
 * The client's assertion (RFC 7523 §3): it names the client as issuer and
 * subject, and the authorization server's issuer identifier, and nothing
 * else, as its audience, as the update of RFC 7523's audience rules asks
 * (draft-ietf-oauth-rfc7523bis), so it is good at no other server. It is
 * good for five minutes, once (`jti`).
 */
const assertionOf = (input: {
  readonly clientId: string;
  readonly issuer: string;
  readonly key: SigningKey;
  readonly algorithm: SigningAlgorithm;
  readonly now: DateTime.Utc;
}): Redacted.Redacted<string> => {
  const issuedAt = Math.floor(DateTime.toEpochMillis(input.now) / 1000);
  const header = base64url(JSON.stringify({ alg: input.algorithm, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: input.clientId,
      sub: input.clientId,
      aud: input.issuer,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      jti: NodeCrypto.randomUUID(),
    }),
  );
  const signed = `${header}.${claims}`;
  const signature = signatureOf(input.algorithm, input.key.key, new TextEncoder().encode(signed));
  return Redacted.make(`${signed}.${Base64Url.encode(signature)}`);
};

/**
 * A digest of the credentials as resolved (their references replaced by
 * their values), to tell the ones a token was got
 * with, or the server refused, from those given since. No value is kept.
 */
export const fingerprintOf = (service: ServiceCredentials): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        service.issuer,
        Redacted.value(service.clientId),
        service.credential._tag,
        Redacted.value(service.credential.value),
        service.scope,
      ]),
    )
    .digest("hex");

/**
 * How the client proves itself at this server, or none when the server
 * takes no way the credential can: a secret goes in a Basic header where the
 * server takes that, which every server must (RFC 6749 §2.3.1), else in the
 * body; a key signs with an algorithm the server lists, or its first when
 * the server lists none.
 */
const tokenClientOf = (
  metadata: AuthorizationServerMetadata,
  service: ServiceCredentials,
  now: DateTime.Utc,
): Effect.Effect<Endpoints.TokenClient, OAuthFailure> => {
  const clientId = Redacted.value(service.clientId);
  const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const credential = service.credential;
  if (credential._tag === "client-secret") {
    const method = (["client_secret_basic", "client_secret_post"] as const).find((each) =>
      methods.includes(each),
    );
    return method === undefined
      ? Effect.fail(new OAuthFailure({ reason: "grant-unsupported" }))
      : Effect.succeed({
          clientId,
          clientSecret: Option.some(credential.value),
          authMethod: method,
        });
  }
  if (!methods.includes("private_key_jwt")) {
    return Effect.fail(new OAuthFailure({ reason: "grant-unsupported" }));
  }
  const key = signingKeyOf(Redacted.value(credential.value));
  if (Option.isNone(key)) return Effect.fail(new OAuthFailure({ reason: "key-unusable" }));
  const listed = metadata.token_endpoint_auth_signing_alg_values_supported;
  const algorithm =
    listed === undefined
      ? key.value.algorithms[0]
      : key.value.algorithms.find((each) => listed.includes(each));
  if (algorithm === undefined) return Effect.fail(new OAuthFailure({ reason: "key-unusable" }));
  return Effect.succeed({
    clientId,
    authMethod: "private_key_jwt",
    assertion: assertionOf({ clientId, issuer: metadata.issuer, key: key.value, algorithm, now }),
  });
};

/**
 * Whether the server can sign in a service whose credential is of `kind`:
 * it offers the client credentials grant, when it lists its grants at all,
 * and a way for that credential to prove itself.
 */
export const takesServices = (
  metadata: AuthorizationServerMetadata,
  kind: ServiceCredentials["credential"]["_tag"],
): boolean => {
  if (metadata.grant_types_supported !== undefined) {
    if (!grantsOf(metadata).includes("client_credentials")) return false;
  }
  const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  return kind === "client-secret"
    ? methods.includes("client_secret_basic") || methods.includes("client_secret_post")
    : methods.includes("private_key_jwt");
};

/**
 * A token for `resource` from the server whose metadata this is, with the
 * client credentials grant (RFC 6749 §4.4.2) and the resource indicator
 * (RFC 8707). The caller has checked the server is the one the credentials
 * were issued by: they go to no other.
 */
export const serviceTokens = Effect.fn("OAuth.serviceTokens")(function* (input: {
  readonly metadata: AuthorizationServerMetadata;
  readonly service: ServiceCredentials;
  readonly resource: string;
  readonly scopes: ReadonlyArray<string>;
}) {
  if (!takesServices(input.metadata, input.service.credential._tag)) {
    return yield* new OAuthFailure({ reason: "grant-unsupported" });
  }
  const client = yield* tokenClientOf(input.metadata, input.service, yield* DateTime.now);
  return yield* Endpoints.requestTokens({
    endpoint: input.metadata.token_endpoint,
    client,
    params: [
      ["grant_type", "client_credentials"],
      ...(input.scopes.length > 0 ? [["scope", input.scopes.join(" ")] as const] : []),
    ],
    resource: input.resource,
  });
});
