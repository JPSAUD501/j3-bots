// SPDX-License-Identifier: AGPL-3.0-or-later
import { EnvironmentAuthorizationError, ServerSettingsError, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

// Whether a bot may use the engine's browser is the engine's agent browser
// access, which J3 Bots turns off engine-wide (`Provision.ts`) and on for one
// project at a time, through the project's settings overrides. The engine
// reads it when it starts a thread's provider session: a project with
// `enableAgentBrowserAccess: true` gets the `preview` capability on that
// session's tool credential, and with it the browser tools; one without gets
// none (**Read** at `59651c1`, `ProviderSessionManager.ts`,
// `agentAccessSettings` and `prepareMcpSession`). A provider session that is
// already running keeps the tools it started with until it is replaced.

/**
 * One project's overrides as the engine stores them, every key kept: an
 * update replaces a project's whole set, except its `providerInstances`
 * (**Read**, `contracts/src/settings.ts`, `ServerSettingsPatch`), so the
 * adapter writes back what it read with its one key changed.
 */
export const ProjectOverrides = Schema.Record(Schema.String, Schema.Unknown);
export type ProjectOverrides = typeof ProjectOverrides.Type;

/** The engine's key for a project's agent browser access. */
const BROWSER_ACCESS_KEY = "enableAgentBrowserAccess";

/**
 * The engine's `server.getSettings`, read only for the projects' overrides.
 * It needs `orchestration:read`.
 */
export const GetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    projectSettingsOverrides: Schema.Record(Schema.String, ProjectOverrides),
  }),
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

/**
 * The engine's `server.updateSettings`, sending only projects' overrides: a
 * project's set replaces the one it had, and `null` removes it. Its answer,
 * the whole settings, is left unread. It needs `settings:write` (**Read**,
 * `RpcAuthorization.ts`, `requiredScopesForServerSettingsPatch`).
 */
export const UpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: Schema.Struct({
      projectSettingsOverrides: Schema.Record(Schema.String, Schema.NullOr(ProjectOverrides)),
    }),
  }),
  success: Schema.Struct({}),
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

/**
 * The project's set of overrides with its browser access set to `enabled`,
 * or `null` when it already has it.
 */
export const withBrowserAccess = (
  current: ProjectOverrides | undefined,
  enabled: boolean,
): ProjectOverrides | null =>
  current?.[BROWSER_ACCESS_KEY] === enabled ? null : { ...current, [BROWSER_ACCESS_KEY]: enabled };
