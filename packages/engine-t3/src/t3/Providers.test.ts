// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { ProviderInstance } from "../Engine.ts";
import {
  CONNECT_COMMAND,
  ConfigStreamEvent,
  providerStatuses,
  providersOfEvent,
} from "./Providers.ts";
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

/**
 * The engine's report of an instance, as one config stream event carries it:
 * installed, enabled and ready unless told otherwise.
 */
const reported = (provider: ProviderInstance, fields: Record<string, unknown>) =>
  providersOfEvent(
    Schema.decodeSync(ConfigStreamEvent)({
      version: 1,
      type: "providerStatuses",
      payload: {
        providers: [
          {
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
          },
        ],
      },
    }),
  ) ?? [];

const statusOf = (provider: ProviderInstance, fields: Record<string, unknown> | undefined) =>
  providerStatuses([provider], fields === undefined ? [] : reported(provider, fields))[0];

/** A five-hour window as Claude Code's probe reports it, with what a case changes. */
const window = (fields: Record<string, unknown>) => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 38,
  ...fields,
});

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
      checking: false,
    });
  });

  it("is unavailable until the engine reports it able to run", () => {
    for (const fields of [
      undefined,
      { installed: false },
      // A check that did not find it.
      { installed: false, status: "error" },
      { enabled: false },
      { availability: "unavailable" },
      { status: "error" },
    ]) {
      assert.deepStrictEqual(statusOf(claude, fields)?.status, {
        _tag: "unavailable",
        checking: false,
      });
    }
  });

  it("is still being checked until the engine's first check since it started ends", () => {
    // What the engine publishes for Claude Code and Codex before that check.
    const notChecked = {
      installed: false,
      status: "warning",
      auth: { status: "unknown" },
      message: "Claude provider status has not been checked in this session yet.",
    };
    assert.deepStrictEqual(statusOf(claude, notChecked)?.status, {
      _tag: "unavailable",
      checking: true,
    });
    // The engine reports an ACP agent it checked and found not set up the same way.
    assert.deepStrictEqual(statusOf(scripted, notChecked)?.status, {
      _tag: "unavailable",
      checking: false,
    });
  });

  it("reports the usage windows the engine reports, as percent used with their resets", () => {
    // As Claude Code's probe reports a subscription (**Read** at `db51b67`,
    // `claudeUsageResponseToLimits`): a five-hour and a weekly window, and a
    // weekly one for a single model with no reset given.
    const status = statusOf(claude, {
      usageLimits: {
        checkedAt: "2026-11-20T12:00:00Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 38,
            resetsAt: "2026-11-20T14:20:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 71.5,
            resetsAt: "2026-11-24T09:00:00.000Z",
            windowDurationMins: 10080,
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 100,
            windowDurationMins: 10080,
          },
        ],
      },
    });
    assert.deepStrictEqual(status?.usage, [
      {
        label: "Session",
        usedPercent: 38,
        resetsAt: DateTime.makeUnsafe("2026-11-20T14:20:00.000Z"),
      },
      {
        label: "Weekly",
        usedPercent: 71.5,
        resetsAt: DateTime.makeUnsafe("2026-11-24T09:00:00.000Z"),
      },
      { label: "Weekly · Fable", usedPercent: 100, resetsAt: null },
    ]);
  });

  it("keeps the windows the engine kept after a failed check", () => {
    // The engine merges a turn's rate-limit updates into limits whose last
    // probe failed, and keeps them marked unavailable (**Read** at `db51b67`,
    // `applyUsageLimitsUpdate`).
    const status = statusOf(claude, {
      usageLimits: {
        checkedAt: "2026-11-20T12:00:00Z",
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 12 }],
        unavailable: { reason: "probeFailed" },
      },
    });
    assert.deepStrictEqual(status?.usage, [{ label: "Session", usedPercent: 12, resetsAt: null }]);
  });

  it("costs a malformed usage window only itself, never the instance's status", () => {
    // The engine's own list drops a whole instance whose report does not decode.
    const status = statusOf(claude, {
      usageLimits: {
        checkedAt: "2026-11-20T12:00:00Z",
        windows: [
          window({}),
          window({ id: "seven_day", usedPercent: 101 }),
          window({ resetsAt: 0 }),
        ],
      },
    });
    assert.deepStrictEqual(status?.status, { _tag: "ready" });
    assert.deepStrictEqual(status?.usage, [{ label: "Session", usedPercent: 38, resetsAt: null }]);

    const withoutWindows = statusOf(claude, { usageLimits: { checkedAt: "2026-11-20T12:00:00Z" } });
    assert.deepStrictEqual(withoutWindows?.status, { _tag: "ready" });
    assert.deepStrictEqual(withoutWindows?.usage, []);
  });

  it("reads a reset only from a well-formed ISO 8601 timestamp", () => {
    const resetOf = (resetsAt: string) =>
      statusOf(claude, {
        usageLimits: { checkedAt: "2026-11-20T12:00:00Z", windows: [window({ resetsAt })] },
      })?.usage[0]?.resetsAt;
    assert.deepStrictEqual(
      resetOf("2026-11-20T14:20:00+02:00"),
      DateTime.makeUnsafe("2026-11-20T12:20:00.000Z"),
    );
    assert.deepStrictEqual(
      resetOf("2028-02-29T00:00Z"),
      DateTime.makeUnsafe("2028-02-29T00:00:00Z"),
    );
    for (const malformed of ["0", "2026-02-30T10:00:00Z", "2026-11-20T24:00:00Z", "2026-11-20"]) {
      assert.strictEqual(resetOf(malformed), null);
    }
  });
});
