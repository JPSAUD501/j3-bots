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
  ConnectorId as SecretsConnectorId,
} from "../secrets/ConnectorSecret.ts";
import type { Secrets } from "../secrets/Secrets.ts";
import type { ConnectorSignIns } from "./auth.ts";
import type { StoredConnector } from "./ConnectorStore.ts";
import { failureOf, referencesOf, type Resolved, usersOf, withValues } from "./secretReferences.ts";

/**
 * How a connector's requests are signed: the headers and the address from
 * its connector secret, with the operator's secrets it names resolved, and an
 * OAuth connector's token from its sign-in, each read when a request is made.
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
 * Secret values a request can carry, to take out of what its server says: a
 * gallery entry's secret values and the operator's secrets its settings name,
 * as given and URL-encoded, as a form puts one in the address. No form
 * encodes a value any other way.
 */
export const hiddenOf = (
  values: ReadonlyArray<Redacted.Redacted<string>>,
): ReadonlyArray<Redacted.Redacted<string>> =>
  values.flatMap((value) => {
    const raw = Redacted.value(value);
    const encoded = encodeURIComponent(raw);
    return encoded === raw ? [value] : [value, Redacted.make(encoded)];
  });

/** The values a resolved connector's server's answers are scrubbed of. */
const hiddenOfResolved = (resolved: Resolved) =>
  hiddenOf([...resolved.secret.formSecrets.map((named) => named.value), ...resolved.values]);

/**
 * The connector's secret with each reference to the operator's secrets
 * resolved, for every bot the connector goes to: none when it has none. A
 * reference that does not resolve fails the request before anything is sent,
 * so no `${secret:…}` text, and no value for a bot that may not use it,
 * reaches its server.
 */
const resolvedOf = (
  secrets: typeof Secrets.Service,
  connector: StoredConnector,
): Effect.Effect<Option.Option<Resolved>, CredentialsUnavailable> =>
  Effect.gen(function* () {
    const secret = yield* secretOf(secrets, connector);
    if (Option.isNone(secret)) return Option.none();
    const values = yield* secrets
      .referenceValues({
        references: referencesOf(secret.value),
        users: usersOf(connector.grant),
      })
      .pipe(Effect.mapError(failureOf));
    return Option.some(withValues(secret.value, values));
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
  NonNullable<ConnectorSecret["command"]> &
    Pick<ConnectorSecret, "env"> & {
      /** The operator's secrets' values in it, which the process's answers are scrubbed of. */
      readonly hidden: ReadonlyArray<Redacted.Redacted<string>>;
    },
  CredentialsUnavailable
> =>
  Effect.gen(function* () {
    const resolved = yield* resolvedOf(secrets, connector);
    if (Option.isNone(resolved)) return yield* new AuthFailing({ reason: "secret-unusable" });
    const { secret, values } = resolved.value;
    const { command } = secret;
    if (command === null) return yield* new AuthFailing({ reason: "secret-unusable" });
    return { program: command.program, args: command.args, env: secret.env, hidden: values };
  });

/**
 * Signs the connector's requests from its secret and, for an OAuth connector,
 * its sign-in. `current` is asked first, right before each request goes out:
 * the connector as stored now, or none once the session's holder may no
 * longer use it, which withdraws the request unsigned. Its references
 * resolve for the bots it goes to now, not those of when the session opened.
 */
export const credentialsOf = (
  secrets: typeof Secrets.Service,
  signIns: typeof ConnectorSignIns.Service,
  connector: StoredConnector,
  current: Effect.Effect<Option.Option<StoredConnector>>,
): ConnectorCredentials => ({
  current: Effect.gen(function* () {
    const now = yield* current;
    if (Option.isNone(now)) return yield* new Withdrawn();
    const resolved = yield* resolvedOf(secrets, now.value);
    const headers = Option.match(resolved, { onNone: () => [], onSome: (r) => r.secret.headers });
    const hidden = Option.match(resolved, { onNone: () => [], onSome: hiddenOfResolved });
    const bearer =
      now.value.signIn === "oauth"
        ? Option.some(yield* signIns.accessToken(now.value.id))
        : Option.none();
    return { bearer, headers, hidden } satisfies CallCredentials;
  }),
  rejected: (wwwAuthenticate, sent) =>
    connector.signIn === "oauth"
      ? signIns.rejected(connector.id, wwwAuthenticate, sent)
      : Effect.fail(new NeedsSignIn()),
});
