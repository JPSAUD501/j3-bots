// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CommandError, Conflict, Invalid, NotFound } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

/**
 * Why a sign-in, a refresh or a revocation did not go through. The reason is
 * all it carries: never a token, a code, an address with a query, or a
 * provider's own description, which is text from a remote server.
 */
export const OAuthFailureReason = Schema.Literals([
  /** The server could not be reached, timed out, failed, or redirected. */
  "unreachable",
  /** An answer was not the document it should be, or was too large. */
  "invalid-response",
  /** The server publishes no protected resource or authorization server metadata. */
  "no-metadata",
  /** A metadata document names an address that is not public `https`. */
  "insecure-endpoint",
  /** The resource metadata is for another resource than the connector's server. */
  "resource-mismatch",
  /**
   * The resource a sign-in would name, in the browser's address and to the
   * authorization server, holds a secret value of the connector's form.
   */
  "secret-in-resource",
  /** The authorization server's metadata names another issuer. */
  "issuer-mismatch",
  /** The authorization server does not offer PKCE with S256. */
  "pkce-unsupported",
  /** No client to sign in as: no registration endpoint and none the operator gave. */
  "registration-unsupported",
  /** The registration endpoint refused J3 Bots, or answered a client it cannot use. */
  "registration-refused",
  /** The operator's client is for another authorization server than the one the connector uses. */
  "client-mismatch",
  /** The authorization code or the refresh token is no longer good. */
  "invalid-grant",
  /** The authorization server refused the client itself. */
  "invalid-client",
  /** The token endpoint refused for another reason, or gave a token that is not a Bearer. */
  "token-refused",
  /** The vault is locked, so nothing can be read or saved. */
  "vault-locked",
  /** The vault has no master password yet, so nothing can be saved. */
  "vault-not-set-up",
  /** No connector has that id. */
  "unknown-connector",
  /** The connector's address is not in the vault. */
  "no-address",
  /** The connector signs in with its form, or not at all, never with OAuth. */
  "not-oauth",
  /** The connector has no tokens saved. */
  "not-signed-in",
  /** The server has no address of its own a browser can return to. */
  "no-server-redirect",
  /** No sign-in under way has that `state`, or it expired, or another device started it. */
  "unknown-sign-in",
  /** The address is not the one the sign-in returns to. */
  "address-mismatch",
  /** The authorization server answered with an error, such as the operator declining. */
  "denied",
]);
export type OAuthFailureReason = typeof OAuthFailureReason.Type;

export class OAuthFailure extends Schema.TaggedError<OAuthFailure>()("OAuthFailure", {
  reason: OAuthFailureReason,
}) {
  override get message(): string {
    return `The connector's sign-in failed: ${this.reason}.`;
  }
}

/** What a client is told when a sign-in it asked for fails. */
export const toCommandError = (error: OAuthFailure): CommandError => {
  switch (error.reason) {
    case "vault-locked":
    case "vault-not-set-up":
    case "no-server-redirect":
    case "registration-refused":
      return new Conflict({ reason: error.reason });
    case "unknown-connector":
      return new NotFound({ resource: "connector" });
    case "unknown-sign-in":
      return new NotFound({ resource: "sign-in" });
    case "not-oauth":
      return new Invalid({ reason: "connector-fields" });
    case "address-mismatch":
      return new Invalid({ reason: "sign-in-url" });
    case "denied":
    case "invalid-grant":
    case "invalid-client":
    case "token-refused":
    case "not-signed-in":
      return new Conflict({ reason: "sign-in-refused" });
    case "unreachable":
      return new Conflict({ reason: "sign-in-unreachable" });
    case "no-address":
    case "invalid-response":
    case "no-metadata":
    case "insecure-endpoint":
    case "resource-mismatch":
    case "secret-in-resource":
    case "issuer-mismatch":
    case "pkce-unsupported":
    case "registration-unsupported":
    case "client-mismatch":
      return new Conflict({ reason: "sign-in-unsupported" });
  }
};
