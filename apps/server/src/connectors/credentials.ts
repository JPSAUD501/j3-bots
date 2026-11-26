// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AuthFailing,
  type CallCredentials,
  type ConnectorCredentials,
  type CredentialsUnavailable,
  NeedsSignIn,
  SecretsUnavailable,
  Withdrawn,
} from "@j3-bots/connectors";
import type { Conflict, ConnectorId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  type ConnectorSecret,
  type NamedSecret,
  ConnectorId as SecretsConnectorId,
} from "../secrets/ConnectorSecret.ts";
import type { Secrets } from "../secrets/Secrets.ts";
import type { ConnectorSignIns } from "./auth.ts";
import type { StoredConnector } from "./ConnectorStore.ts";

/**
 * How a connector's requests are signed: the headers and the address from
 * its connector secret, and an OAuth connector's token from its sign-in, each
 * read when a request is made.
 */

/** A connector's secrets are kept under the connector's own id. */
export const connectorSecretIdOf: (id: ConnectorId) => SecretsConnectorId =
  Schema.decodeSync(SecretsConnectorId);

const unavailable = (conflict: Conflict): CredentialsUnavailable =>
  conflict.reason === "secrets-unavailable"
    ? new SecretsUnavailable()
    : new AuthFailing({ reason: "secret-unusable" });

/**
 * The connector's secret. Every connector has one: its address is
 * there, since a key can be part of it.
 */
const secretOf = (
  secrets: typeof Secrets.Service,
  connector: StoredConnector,
): Effect.Effect<Option.Option<ConnectorSecret>, CredentialsUnavailable> =>
  secrets.connectorSecrets
    .get(connectorSecretIdOf(connector.id))
    .pipe(Effect.mapError(unavailable));

/**
 * The URL to reach the connector at, from its secret: the one the operator
 * typed, or the one a gallery entry's form gave when it was added.
 */
export const addressOf = (
  secrets: typeof Secrets.Service,
  connector: StoredConnector,
): Effect.Effect<URL, CredentialsUnavailable> =>
  Effect.gen(function* () {
    const secret = yield* secretOf(secrets, connector);
    const address = Option.flatMapNullishOr(secret, (s) => s.address);
    const url = Option.flatMapNullishOr(address, (value) => URL.parse(Redacted.value(value)));
    if (Option.isNone(url)) return yield* new AuthFailing({ reason: "secret-unusable" });
    return url.value;
  });

/**
 * A gallery entry's secret values as a request can carry them, to take out
 * of what its server says: as given, and URL-encoded, as its form puts one
 * in the address. No form encodes a value any other way.
 */
export const hiddenOf = (
  formSecrets: ReadonlyArray<NamedSecret>,
): ReadonlyArray<Redacted.Redacted<string>> =>
  formSecrets.flatMap(({ value }) => {
    const raw = Redacted.value(value);
    const encoded = encodeURIComponent(raw);
    return encoded === raw ? [value] : [value, Redacted.make(encoded)];
  });

/**
 * A command connector's command line and environment, as its process is
 * started with them: from its secret alone, which one write replaces
 * whole, never from the program the connector's row shows.
 */
export const commandOf = (
  secrets: typeof Secrets.Service,
  connector: StoredConnector,
): Effect.Effect<
  NonNullable<ConnectorSecret["command"]> & Pick<ConnectorSecret, "env">,
  CredentialsUnavailable
> =>
  Effect.gen(function* () {
    const secret = yield* secretOf(secrets, connector);
    if (Option.isNone(secret) || secret.value.command === null) {
      return yield* new AuthFailing({ reason: "secret-unusable" });
    }
    return { ...secret.value.command, env: secret.value.env };
  });

/**
 * Signs the connector's requests from its secret and, for an OAuth connector,
 * its sign-in. `allowed` is asked first, right before each request goes out:
 * a request it refuses is withdrawn unsigned.
 */
export const credentialsOf = (
  secrets: typeof Secrets.Service,
  signIns: typeof ConnectorSignIns.Service,
  connector: StoredConnector,
  allowed: Effect.Effect<boolean>,
): ConnectorCredentials => ({
  current: Effect.gen(function* () {
    if (!(yield* allowed)) return yield* new Withdrawn();
    const secret = yield* secretOf(secrets, connector);
    const headers = Option.match(secret, { onNone: () => [], onSome: (s) => s.headers });
    const hidden = Option.match(secret, {
      onNone: () => [],
      onSome: (s) => hiddenOf(s.formSecrets),
    });
    const bearer =
      connector.signIn === "oauth"
        ? Option.some(yield* signIns.accessToken(connector.id))
        : Option.none();
    return { bearer, headers, hidden } satisfies CallCredentials;
  }),
  rejected: (wwwAuthenticate, sent) =>
    connector.signIn === "oauth"
      ? signIns.rejected(connector.id, wwwAuthenticate, sent)
      : Effect.fail(new NeedsSignIn()),
});
