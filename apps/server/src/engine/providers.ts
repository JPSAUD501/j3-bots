// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderId } from "@j3-bots/contracts";
import type { ProviderInstance } from "@j3-bots/engine-t3";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ServerConfigShape } from "../config.ts";
import { homeLayout } from "../home/entries.ts";

/**
 * The provider instances the server runs the engine with: Claude Code and
 * Codex, each in a home of its own under `<J3_HOME>/providers`, so bots never
 * inherit the operator's personal setup. They reach their models through the
 * provider connection the operator sets with `j3-bots provider connect`, or
 * through a sign-in made into their home (`docs/architecture/engine.md#provisioning`).
 *
 * With a scripted agent configured (`scriptedAgent`, or `J3_SCRIPTED_AGENT`),
 * it comes first, so a bot created without a model runs on it: for
 * development and test installs, spending no allowance.
 */
export const engineProviders = (
  path: Path.Path,
  config: ServerConfigShape,
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
      },
    ],
  });
  return [
    ...scripted,
    {
      id: ProviderId.make("claude-code"),
      name: "Claude Code",
      harness: "claude-code",
      home: providerHome("claude-code"),
      environment: [],
    },
    {
      id: ProviderId.make("codex"),
      name: "Codex",
      harness: "codex",
      home: providerHome("codex"),
      environment: [],
    },
  ];
};
