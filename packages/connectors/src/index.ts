// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/connectors`: how the J3 Bots server reaches connectors' MCP
 * servers (`docs/architecture/server.md`, "Connectors").
 *
 * - {@link makeGuardedFetch} and {@link layerGuardedHttpClient}: every request
 *   to a URL someone else chose goes through the SSRF guard.
 * - {@link openSession}: one MCP session with a connector's server, signed
 *   from the store at each request.
 * - {@link catalogOf}, {@link compareCatalog} and {@link answerChanges}: the
 *   tools the operator accepted, and the changes held for them.
 * - {@link toolName}: the name a bot calls a connector's tool by.
 * - {@link statusOf} and {@link observe}: a connector's status.
 * - {@link openCommandSession} and {@link makeSupervisor}: a connector started
 *   by command, its process run as `docs/architecture/server.md` says. Which
 *   command lines it takes is `@j3-bots/contracts`' `pinRefusal` and
 *   `reservedVariable`, which clients check too.
 * - The errors a connector's request can end in, none of which carries a URL,
 *   a secret or the remote server's text.
 */
export {
  answerChanges,
  CatalogTool,
  type CatalogState,
  catalogOf,
  compareCatalog,
  type HeldChange,
  ListedTool,
  MAX_DESCRIPTION_CHARACTERS,
} from "./catalog.ts";
export { type CommandSession, openCommandSession } from "./command/session.ts";
export { makeSupervisor, processCapacity, type Supervisor } from "./command/supervisor.ts";
export {
  AuthFailing,
  AuthFailure,
  CommandFailed,
  type ConnectorFailure,
  type CredentialsUnavailable,
  NeedsSignIn,
  NotMcp,
  ResponseTooLarge,
  ServerError,
  TimedOut,
  Unreachable,
  UnreachableReason,
  UrlRefusal,
  UrlRefused,
  VaultLocked,
  Withdrawn,
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
export { ConnectorSlug, MAX_TOOL_NAME, slugFor, toolName } from "./names.ts";
export {
  type CallCredentials,
  type ConnectorCredentials,
  DEFAULT_SESSION_LIMITS,
  type McpSession,
  openSession,
  type SecretHeader,
  type SessionLimits,
  type SessionOptions,
  type ToolAnswer,
} from "./session.ts";
export {
  type Activity,
  type Failing,
  type FailingReason,
  nextFailing,
  type Observation,
  observe,
  type SignInNeed,
  type StatusInputs,
  statusOf,
} from "./status.ts";
