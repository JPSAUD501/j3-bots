// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthFailure, CredentialsUnavailable, VaultLocked } from "@j3-bots/connectors";
import type { BotId, CommandError, ConnectorId, OAuthClientInput } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as DateTime from "effect/DateTime";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";

/**
 * Where an OAuth connector's sign-in stands, as its sign-in reports it. That
 * the service refused a token is the `Connectors` service's to see, from its
 * calls, so it is not here.
 */
export type SignInState =
  | {
      readonly _tag: "signed-in";
      /** The account it is signed in as, when the service says. */
      readonly account: string | null;
      readonly signedInAt: DateTime.Utc;
    }
  | { readonly _tag: "needs-sign-in"; readonly reason: "not-signed-in" | "expired" }
  | { readonly _tag: "vault-locked" }
  | { readonly _tag: "failing"; readonly reason: AuthFailure };

/**
 * The OAuth side of connectors: the `Connectors` service signs a call to an
 * OAuth connector only through this, and never reads a token itself.
 */
export class ConnectorSignIns extends Context.Service<
  ConnectorSignIns,
  {
    /** The access token to send now, refreshed first when it is about to expire. */
    readonly accessToken: (
      id: ConnectorId,
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialsUnavailable>;
    /**
     * The connector's server refused `sent`, the token a request carried,
     * with this `WWW-Authenticate`. A token renewed since it was sent is not
     * renewed again: the request goes once more with the current one.
     */
    readonly rejected: (
      id: ConnectorId,
      wwwAuthenticate: Option.Option<string>,
      sent: Option.Option<Redacted.Redacted<string>>,
    ) => Effect.Effect<void, CredentialsUnavailable>;
    /** A bot's call needed a sign-in it did not have: show the operator the card for it. */
    readonly needed: (input: {
      readonly botId: BotId;
      readonly connectorId: ConnectorId;
    }) => Effect.Effect<void>;
    /**
     * Revokes the sign-in at the service when it offers that, before the
     * connector's secrets go; a service that can't be reached is not waited
     * for. Fails while the vault is locked, since the token is there: the
     * removal finishes once it opens.
     */
    readonly disconnect: (id: ConnectorId) => Effect.Effect<void, VaultLocked>;
    /** Signs in to the connector with the OAuth client the operator registered at the service. */
    readonly useOperatorClient: (
      id: ConnectorId,
      client: OAuthClientInput,
    ) => Effect.Effect<void, CommandError>;
    /** Every OAuth connector's sign-in, again on each change. */
    readonly states: Stream.Stream<ReadonlyMap<ConnectorId, SignInState>>;
  }
>()("@j3-bots/server/connectors/auth/ConnectorSignIns") {}
