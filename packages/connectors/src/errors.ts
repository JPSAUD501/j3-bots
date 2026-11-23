// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/*
 * What can go wrong between J3 Bots and a connector's server. No error here
 * carries a URL, a header, a token or anything the remote server wrote: a URL
 * can hold a key in its query, and a server's error text is untrusted and may
 * echo what it was sent. Each message is fixed or built from fixed tags.
 */

/** Why the guard refused to send a request. */
export const UrlRefusal = Schema.Literals([
  /** Not a URL, or one without a host. */
  "invalid-url",
  /** Plain HTTP (or another scheme) to anything but this machine's loopback, for a command connector. */
  "not-https",
  /** A user name or password in the URL. */
  "userinfo",
  /** The host is, or resolves to, an address in a private, loopback, link-local or reserved range. */
  "private-address",
  /**
   * The host is, or resolves to, only addresses of a private network (RFC 1918,
   * shared or unique local ones), which the operator may confirm, and has not.
   */
  "private-network",
  /** The server answered with a redirect, which this request may not follow. */
  "redirect",
]);
export type UrlRefusal = typeof UrlRefusal.Type;

/** The guard refused a request before it left the server (`docs/architecture/security.md`, "Connectors"). */
export class UrlRefused extends Schema.TaggedError<UrlRefused>()("UrlRefused", {
  reason: UrlRefusal,
}) {
  override get message(): string {
    return `A connector request was refused: ${this.reason}.`;
  }
}

/** Why a connector's server could not be reached. */
export const UnreachableReason = Schema.Literals([
  /** Its name does not resolve. */
  "dns",
  /** No connection within the connect deadline, or the connection was refused. */
  "connect",
  /** The TLS handshake or the certificate failed. */
  "tls",
  /** The connection dropped before an answer. */
  "closed",
]);
export type UnreachableReason = typeof UnreachableReason.Type;

export class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  reason: UnreachableReason,
}) {
  override get message(): string {
    return `A connector's server could not be reached: ${this.reason}.`;
  }
}

/** An answer, or one streamed message in it, grew past what J3 Bots reads. */
export class ResponseTooLarge extends Schema.TaggedError<ResponseTooLarge>()("ResponseTooLarge", {
  limit: Schema.Int,
}) {
  override get message(): string {
    return `A connector's answer was larger than ${this.limit} bytes.`;
  }
}

/** The connector needs the operator to sign in (again) before it can be used. */
export class NeedsSignIn extends Schema.TaggedError<NeedsSignIn>()("NeedsSignIn", {}) {
  override get message(): string {
    return "The connector needs the operator to sign in.";
  }
}

/** The vault is locked, so no connector secret can be read until a client unlocks it. */
export class VaultLocked extends Schema.TaggedError<VaultLocked>()("VaultLocked", {}) {
  override get message(): string {
    return "The vault is locked.";
  }
}

/** Why signing a connector's requests failed, apart from needing a new sign-in. */
export const AuthFailure = Schema.Literals([
  /** The authorization server could not be reached, or answered with an error, while refreshing. */
  "refresh-failed",
  /** The connector's saved secret is not one this release can use. */
  "secret-unusable",
]);
export type AuthFailure = typeof AuthFailure.Type;

/** The connector's sign-in exists but could not be used for this request. */
export class AuthFailing extends Schema.TaggedError<AuthFailing>()("AuthFailing", {
  reason: AuthFailure,
}) {
  override get message(): string {
    return `A connector's sign-in could not be used: ${this.reason}.`;
  }
}

/** Why a connector's credentials can't sign a request. */
export type CredentialsUnavailable = NeedsSignIn | VaultLocked | AuthFailing;
