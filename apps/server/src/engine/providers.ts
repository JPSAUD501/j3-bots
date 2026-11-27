// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderId } from "@j3-bots/contracts";
import type { ProviderInstance } from "@j3-bots/engine-t3";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ServerConfigShape } from "../config.ts";
import { homeLayout } from "../home/entries.ts";
import type { ProviderAccount } from "../providers/Accounts.ts";

/**
 * The provider instances the server runs the engine with: one per AI account
 * the operator set up (`providers/Accounts.ts`), each Claude Code or Codex in
 * a home of its own under `<J3_HOME>/providers`, so bots never inherit the
 * operator's personal setup. They reach their models through the provider
 * connection the operator sets with `j3-bots provider connect`, or through a
 * sign-in made into their home (`docs/architecture/engine.md#provisioning`).
 * Each runs the executable the operator chose for it, and else J3 Bots' own
 * copy of its harness when J3 Bots installed one (`EngineOptions.harnessExecutables`),
 * and else the one the engine finds on `PATH`.
 *
 * With a scripted agent configured (`scriptedAgent`, or `J3_SCRIPTED_AGENT`),
 * it comes first, so a bot created without a model runs on it: for
 * development and test installs, spending no allowance.
 */
export const engineProviders = (
  path: Path.Path,
  config: ServerConfigShape,
  accounts: ReadonlyArray<ProviderAccount>,
): ReadonlyArray<ProviderInstance> => {
  const { providerHome } = homeLayout(path, config.home);
  const scripted: ReadonlyArray<ProviderInstance> = Option.match(config.scriptedAgent, {
    onNone: () => [],
    onSome: (agent) => [
      {
        id: ProviderId.make("scripted"),
        name: "Scripted agent",
        harness: "acp-command",
        command: process.execPath,
        args: [agent],
        environment: [],
        enabled: true,
      },
    ],
  });
  return [
    ...scripted,
    ...accounts.map((account): ProviderInstance => ({
      id: account.id,
      name: account.name,
      harness: account.harness,
      home: providerHome(account.id),
      environment: [],
      enabled: account.enabled,
      binaryPath: account.binaryPath ?? undefined,
      launchArguments: account.launchArguments,
    })),
  ];
};
