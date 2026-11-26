// SPDX-License-Identifier: AGPL-3.0-or-later
import { SECRET_NEED_REASONS, SecretName } from "@j3-bots/contracts";
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

/**
 * The connector needs the operator to sign in (again) before it can be used.
 * `renewed`: the credentials refused were read after the request was first
 * refused with others (a refresh, values given again), so the refusal is of
 * what signs requests now, however long ago the request began.
 */
export class NeedsSignIn extends Schema.TaggedError<NeedsSignIn>()("NeedsSignIn", {
  renewed: Schema.optionalKey(Schema.Boolean),
}) {
  override get message(): string {
    return "The connector needs the operator to sign in.";
  }
}

/** The operator's secrets cannot be read now (`SecretsState`), so no connector secret can be. */
export class SecretsUnavailable extends Schema.TaggedError<SecretsUnavailable>()(
  "SecretsUnavailable",
  {},
) {
  override get message(): string {
    return "The secrets cannot be read.";
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

/**
 * The request may no longer be signed: whoever it was for lost the right to
 * make it (a bot whose grant was taken away, say) before it went out.
 */
export class Withdrawn extends Schema.TaggedError<Withdrawn>()("Withdrawn", {}) {
  override get message(): string {
    return "A connector request was withdrawn before it was sent.";
  }
}

/**
 * A secret the connector's settings name (`${secret:<name>}`) cannot be used
 * (`SECRET_NEED_REASONS`): nothing was sent. It names the secret, never a value.
 */
export class SecretNeeded extends Schema.TaggedError<SecretNeeded>()("SecretNeeded", {
  secret: SecretName,
  reason: Schema.Literals(SECRET_NEED_REASONS),
}) {
  override get message(): string {
    return `A connector cannot use the secret "${this.secret}": ${this.reason}.`;
  }
}

/** Why a connector's credentials can't sign a request. */
export type CredentialsUnavailable =
  | NeedsSignIn
  | SecretsUnavailable
  | SecretNeeded
  | AuthFailing
  | Withdrawn;

/** A connector's server took longer than the deadline J3 Bots gives it. */
export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", {}) {
  override get message(): string {
    return "A connector's server did not answer in time.";
  }
}

/** A connector's server answered with an HTTP or MCP error of its own. */
export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  /** The HTTP status, when the error was one; null for an MCP error. */
  status: Schema.NullOr(Schema.Int),
}) {
  override get message(): string {
    return this.status === null
      ? "A connector's server answered with an error."
      : `A connector's server answered with HTTP ${this.status}.`;
  }
}

/** What a connector's server answered is not an MCP server's answer. */
export class NotMcp extends Schema.TaggedError<NotMcp>()("NotMcp", {}) {
  override get message(): string {
    return "A connector's server did not answer as an MCP server.";
  }
}

/** Why a command connector's process is not there to answer. */
const CommandFailure = Schema.Literals([
  /** Its program is not on the server: no such file, or none on the search path. */
  "not-found",
  /** Its process could not start, or ended before it answered. */
  "exited",
  /**
   * The server does not start the command line as it is saved, one its
   * checks refuse as it starts: a package at no exact version on the program
   * found, an argument Windows' command interpreter would read, or a variable
   * that decides which code runs taking its value from a secret.
   */
  "refused",
]);

/** A command connector's process is not running to answer. Nothing it printed is kept. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  reason: CommandFailure,
}) {
  override get message(): string {
    return `A command connector's process is not running: ${this.reason}.`;
  }
}

/** Every way a request to a connector can fail. */
export type ConnectorFailure =
  | CredentialsUnavailable
  | UrlRefused
  | Unreachable
  | ResponseTooLarge
  | TimedOut
  | ServerError
  | NotMcp
  | CommandFailed;
