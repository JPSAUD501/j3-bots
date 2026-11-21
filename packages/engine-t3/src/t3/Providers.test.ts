// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProviderInstance } from "../Engine.ts";
import { CONNECT_COMMAND, providerStatuses } from "./Providers.ts";
import { instanceIdFor } from "./Provision.ts";

const claude: ProviderInstance = {
  id: ProviderId.make("claude-code"),
  name: "Claude Code",
  environment: [],
  harness: "claude-code",
  home: "/j3/providers/claude-code",
};
const scripted: ProviderInstance = {
  id: ProviderId.make("scripted"),
  name: "Scripted agent",
  environment: [],
  harness: "acp-command",
  command: "node",
  args: ["agent.js"],
};

/** The engine's report of an instance: installed, enabled and ready unless told otherwise. */
const reported = (provider: ProviderInstance, fields: Record<string, unknown>) =>
  Schema.decodeSync(ServerProvider)({
    instanceId: instanceIdFor(provider.id),
    driver: provider.harness === "acp-command" ? "acpRegistry" : "claudeAgent",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-11-20T12:00:00Z",
    models: [
      { slug: "claude-haiku-5-5", name: "Haiku 5.5", isCustom: false, capabilities: null },
      { slug: "x".repeat(129), name: "Too long", isCustom: false, capabilities: null },
    ],
    ...fields,
  });

const statusOf = (provider: ProviderInstance, fields: Record<string, unknown> | undefined) =>
  providerStatuses([provider], fields === undefined ? [] : [reported(provider, fields)])[0];

describe("providerStatuses", () => {
  it("is ready with the models whose ids J3 Bots can hold", () => {
    const status = statusOf(claude, {});
    assert.deepStrictEqual(status?.status, { _tag: "ready" });
    assert.deepStrictEqual(status?.models, [
      { id: ModelId.make("claude-haiku-5-5"), name: "Haiku 5.5" },
    ]);
  });

  it("asks for the connect command when a harness has no way to its models", () => {
    assert.deepStrictEqual(statusOf(claude, { auth: { status: "unauthenticated" } })?.status, {
      _tag: "sign-in-required",
      command: CONNECT_COMMAND,
    });
    // An ACP agent cannot be connected that way.
    assert.deepStrictEqual(statusOf(scripted, { auth: { status: "unauthenticated" } })?.status, {
      _tag: "unavailable",
    });
  });

  it("is unavailable until the engine reports it able to run", () => {
    for (const fields of [
      undefined,
      { installed: false },
      { enabled: false },
      { availability: "unavailable" },
      { status: "error" },
    ]) {
      assert.deepStrictEqual(statusOf(claude, fields)?.status, { _tag: "unavailable" });
    }
  });
});
