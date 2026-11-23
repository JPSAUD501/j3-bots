// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AuthFailing,
  type CallCredentials,
  type ConnectorCredentials,
  type CredentialsUnavailable,
  NeedsSignIn,
  VaultLocked,
  Withdrawn,
} from "@j3-bots/connectors";
import type { Conflict, ConnectorId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ConnectorSecret, ConnectorId as VaultConnectorId } from "../vault/ConnectorSecret.ts";
import type { Vault } from "../vault/Vault.ts";
import type { ConnectorSignIns } from "./auth.ts";
import type { StoredConnector } from "./ConnectorStore.ts";

/**
 * How a connector's requests are signed: the headers and the address from
 * its vault record, and an OAuth connector's token from its sign-in, each
 * read when a request is made.
 */

/** The vault files a connector's secrets under the connector's own id. */
export const vaultIdOf: (id: ConnectorId) => VaultConnectorId = Schema.decodeSync(VaultConnectorId);

const unavailable = (conflict: Conflict): CredentialsUnavailable =>
  conflict.reason === "vault-locked"
    ? new VaultLocked()
    : new AuthFailing({ reason: "secret-unusable" });

/**
 * The connector's vault record. Every connector has one: its address is
 * there, since a key can be part of it.
 */
const secretOf = (
  vault: typeof Vault.Service,
  connector: StoredConnector,
): Effect.Effect<Option.Option<ConnectorSecret>, CredentialsUnavailable> =>
  vault.connectorSecrets.get(vaultIdOf(connector.id)).pipe(Effect.mapError(unavailable));

/**
 * The URL to reach the connector at, from the vault: the one the operator
 * typed, or the one a gallery entry's form gave when it was added.
 */
export const addressOf = (
  vault: typeof Vault.Service,
  connector: StoredConnector,
): Effect.Effect<URL, CredentialsUnavailable> =>
  Effect.gen(function* () {
    const secret = yield* secretOf(vault, connector);
    const address = Option.flatMapNullishOr(secret, (s) => s.address);
    const url = Option.flatMapNullishOr(address, (value) => URL.parse(Redacted.value(value)));
    if (Option.isNone(url)) return yield* new AuthFailing({ reason: "secret-unusable" });
    return url.value;
  });

/**
 * Signs the connector's requests from the vault and, for an OAuth connector,
 * its sign-in. `allowed` is asked first, right before each request goes out:
 * a request it refuses is withdrawn unsigned.
 */
export const credentialsOf = (
  vault: typeof Vault.Service,
  signIns: typeof ConnectorSignIns.Service,
  connector: StoredConnector,
  allowed: Effect.Effect<boolean>,
): ConnectorCredentials => ({
  current: Effect.gen(function* () {
    if (!(yield* allowed)) return yield* new Withdrawn();
    const secret = yield* secretOf(vault, connector);
    const headers = Option.match(secret, { onNone: () => [], onSome: (s) => s.headers });
    const bearer =
      connector.signIn === "oauth"
        ? Option.some(yield* signIns.accessToken(connector.id))
        : Option.none();
    return { bearer, headers } satisfies CallCredentials;
  }),
  rejected: (wwwAuthenticate, sent) =>
    connector.signIn === "oauth"
      ? signIns.rejected(connector.id, wwwAuthenticate, sent)
      : Effect.fail(new NeedsSignIn()),
});
