// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/connectors`: how the J3 Bots server reaches connectors' MCP
 * servers (`docs/architecture/server.md`, "Connectors").
 *
 * - {@link makeGuardedFetch} and {@link layerGuardedHttpClient}: every request
 *   to a URL someone else chose goes through the SSRF guard.
 * - The errors a connector's request can end in, none of which carries a URL,
 *   a secret or the remote server's text.
 */
export {
  AuthFailing,
  AuthFailure,
  type CredentialsUnavailable,
  NeedsSignIn,
  ResponseTooLarge,
  Unreachable,
  UnreachableReason,
  UrlRefusal,
  UrlRefused,
  VaultLocked,
} from "./errors.ts";
export {
  checkUrl,
  DEFAULT_GUARD,
  type GuardedFetch,
  type GuardOptions,
  layerGuardedHttpClient,
  makeGuardedFetch,
  type ResolvedAddress,
  type Resolver,
  type UrlPolicy,
} from "./guard.ts";
