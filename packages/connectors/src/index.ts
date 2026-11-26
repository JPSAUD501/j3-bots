// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/connectors`: how the J3 Bots server reaches connectors' MCP
 * servers (`docs/architecture/server.md`, "Connectors").
 *
 * - {@link makeGuardedFetch} and {@link layerGuardedHttpClient}: every request
 *   to a URL someone else chose goes through the SSRF guard.
 * - {@link openSession}: a connection to a connector's server at the
 *   current revision of MCP or the one it speaks, signed from the store at
 *   each request: its tools, resources and prompts, its requests for input,
 *   and calls it runs as tasks.
 * - {@link catalogOf}: a server's tools, cleaned into what bots are offered.
 * - {@link elicitationOf}: a server's request for input, as the operator
 *   sees it.
 * - {@link toolName}: the name a bot calls a connector's tool by.
 * - {@link statusOf} and {@link observe}: a connector's status.
 * - {@link openCommandSession} and {@link makeSupervisor}: a connector started
 *   by command, its process run as `docs/architecture/server.md` says. Which
 *   command lines it takes is `@j3-bots/contracts`' `pinRefusal` and
 *   `reservedVariable`, which clients check too.
 * - The errors a connector's request can end in, none of which carries a URL,
 *   a secret or the remote server's text.
 */
export { type AppDocument, appDocumentOf, MAX_APP_RESOURCE_JSON_BYTES } from "./app.ts";
export {
  CatalogTool,
  catalogOf,
  ListedTool,
  MAX_DESCRIPTION_CHARACTERS,
  toolUiOf,
} from "./catalog.ts";
export { type ResourceContents, resourceText } from "./content.ts";
export { type ElicitationRefusal, elicitationOf } from "./elicitation.ts";
export type { Prompt, PromptArgument, Resource } from "./features.ts";
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
  SecretNeeded,
  SecretsUnavailable,
  ServerError,
  TimedOut,
  Unreachable,
  UnreachableReason,
  UrlRefusal,
  UrlRefused,
  Withdrawn,
} from "./errors.ts";
export {
  checkedAddresses,
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
  type CallHooks,
  type CallProgress,
  type ClientSetup,
  type ConnectorCredentials,
  DEFAULT_SESSION_LIMITS,
  type ListKind,
  type McpSession,
  openSession,
  sameHeaders,
  type PromptText,
  type ResourceRead,
  type ResponseCache,
  responseCache,
  type SecretHeader,
  type ServerInfo,
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
  type SecretNeed,
  type SignInNeed,
  type StatusInputs,
  statusOf,
} from "./status.ts";
