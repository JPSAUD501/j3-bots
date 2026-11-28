// SPDX-License-Identifier: AGPL-3.0-or-later
import { EnvironmentAuthorizationError, ServerSettingsError, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

// The engine's settings the adapter reads and writes while the engine runs.
// Provisioning writes the rest before each start (`Provision.ts`).

/**
 * One project's overrides as the engine stores them, every key kept: an
 * update replaces a project's whole set, except its `providerInstances`
 * (**Read**, `contracts/src/settings.ts`, `ServerSettingsPatch`), so the
 * adapter writes back what it read with its one key changed.
 */
export const ProjectOverrides = Schema.Record(Schema.String, Schema.Unknown);
export type ProjectOverrides = typeof ProjectOverrides.Type;

/**
 * The engine's key for a project's agent browser access, which releases
 * before 0.16 set for each bot given the engine's browser. The engine reads
 * it when it starts a thread's provider session (**Read** at `bc0f04d`,
 * `ProviderSessionManager.ts`, `agentAccessSettings`).
 */
const BROWSER_ACCESS_KEY = "enableAgentBrowserAccess";

/**
 * The engine's `server.getSettings`, read only for the projects' overrides,
 * to clear the browser access releases before 0.16 wrote there.
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
 * One provider instance replaced whole by the entry provisioning writes for
 * it (`instanceEntry`), or removed (**Read** at `bc0f04d`,
 * `ProviderInstanceMutation` in `providerInstance.ts`).
 */
export const InstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: Schema.String,
    instance: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ operation: Schema.Literal("remove"), instanceId: Schema.String }),
]);
export type InstanceMutation = typeof InstanceMutation.Type;

/**
 * The engine's `server.updateSettings`, sending only what the adapter
 * changes while the engine runs: projects' overrides, where a project's set
 * replaces the one it had and `null` removes it, or the switch for suggested
 * replies (`promptSuggestionsEnabled`), each of which needs `settings:write`;
 * or one provider instance (`InstanceMutation`), with an empty patch, which
 * needs `providers:manage` (**Read** at `bc0f04d`, `RpcAuthorization.ts`,
 * `requiredScopesForSettingsUpdate`). Its answer, the whole settings, is
 * left unread.
 */
export const UpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: Schema.Struct({
      projectSettingsOverrides: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.NullOr(ProjectOverrides)),
      ),
      promptSuggestionsEnabled: Schema.optionalKey(Schema.Boolean),
    }),
    providerInstanceMutation: Schema.optionalKey(InstanceMutation),
  }),
  success: Schema.Struct({}),
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

/**
 * The project's set of overrides without its browser access, `null` when
 * nothing else is left in it, or `undefined` when it has none to remove.
 */
export const withoutBrowserAccess = (
  current: ProjectOverrides,
): ProjectOverrides | null | undefined => {
  if (!(BROWSER_ACCESS_KEY in current)) return undefined;
  const { [BROWSER_ACCESS_KEY]: _removed, ...rest } = current;
  return Object.keys(rest).length === 0 ? null : rest;
};
