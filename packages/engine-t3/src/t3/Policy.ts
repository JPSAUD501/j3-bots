// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PermissionMode } from "@j3-bots/contracts";
import {
  EnvironmentAuthorizationError,
  KeybindingsConfigError,
  RuntimeMode,
  ServerSettingsError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

/**
 * The engine's `server.getConfig`, read only for the runtime-mode ceiling of
 * an administrator's policy. The config's `managedPolicy` is the summary the
 * orchestrator takes its ceiling from: both are the settings service's
 * `managedPolicy`, read once when the engine starts (**Read** at `bc0f04d`,
 * `ws.ts` `loadServerConfig`, `Orchestrator.ts` `runtimeModeCeiling`). The
 * rest of the config is left unread, so no change to it costs this read.
 */
export const GetServerConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    managedPolicy: Schema.optionalKey(
      Schema.Struct({
        limits: Schema.optionalKey(
          Schema.Struct({ maxRuntimeMode: Schema.optionalKey(RuntimeMode) }),
        ),
      }),
    ),
  }),
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

/** The engine's runtime mode for each permission mode. */
export const RUNTIME_MODES = {
  supervised: "approval-required",
  "auto-accept-edits": "auto-accept-edits",
  auto: "auto",
  "full-access": "full-access",
} as const satisfies Record<PermissionMode, RuntimeMode>;

/** The permission mode each of the engine's runtime modes is. */
export const PERMISSION_MODES = {
  "approval-required": "supervised",
  "auto-accept-edits": "auto-accept-edits",
  auto: "auto",
  "full-access": "full-access",
} as const satisfies Record<RuntimeMode, PermissionMode>;
