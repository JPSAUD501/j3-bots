// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_PROVIDER_DETAIL, ModelId, ProviderId, type ProviderStatus } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ProviderInstance } from "../Engine.ts";
import {
  CONNECT_COMMAND,
  ConfigStreamEvent,
  providerProblems,
  providerStatuses,
  providersOfEvent,
  REDACTED,
  type UpdateRequest,
  withFirstCheckBudget,
  withoutSecrets,
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

/** One instance's status, within the engine's first-check budget unless `firstCheck` says otherwise. */
const statusOf = (
  provider: ProviderInstance,
  fields: Record<string, unknown> | undefined,
  firstCheck = true,
) =>
  providerStatuses(
    [provider],
    fields === undefined ? [] : reported(provider, fields),
    firstCheck,
  )[0];

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
      reason: "failed",
    });
  });

  it("says why the engine cannot run it, in its own words where it gave any", () => {
    const notFound = "Claude Agent CLI (`claude`) was not found on PATH.";
    const timedOut =
      "Claude Agent CLI is installed but failed to run. Timed out while running command.";
    const cases: ReadonlyArray<
      readonly [Record<string, unknown> | undefined, ProviderStatus["status"]]
    > = [
      // Missing from the engine's list.
      [undefined, { _tag: "unavailable", checking: false, reason: "failed" }],
      // A check that did not find the harness on the engine's PATH.
      [
        { installed: false, status: "error", message: notFound },
        { _tag: "unavailable", checking: false, reason: "not-installed", detail: notFound },
      ],
      [{ installed: false }, { _tag: "unavailable", checking: false, reason: "not-installed" }],
      // An instance the engine could not create.
      [
        {
          availability: "unavailable",
          unavailableReason: "Driver 'claudeAgent' failed to create instance.",
          installed: false,
          enabled: false,
          status: "error",
        },
        {
          _tag: "unavailable",
          checking: false,
          reason: "failed",
          detail: "Driver 'claudeAgent' failed to create instance.",
        },
      ],
      // Turned off, in J3 Bots' provisioning or in the engine's settings: the
      // engine's words name its own settings, not J3 Bots'.
      [
        {
          enabled: false,
          installed: false,
          status: "disabled",
          message: "Claude is disabled in T3 Code settings.",
        },
        { _tag: "unavailable", checking: false, reason: "disabled" },
      ],
      [{ status: "disabled" }, { _tag: "unavailable", checking: false, reason: "disabled" }],
      // Found, but its check failed or timed out.
      [
        { status: "error", message: timedOut },
        { _tag: "unavailable", checking: false, reason: "failed", detail: timedOut },
      ],
      // Words longer than J3 Bots holds are cut.
      [
        { status: "error", message: "x".repeat(MAX_PROVIDER_DETAIL + 50) },
        {
          _tag: "unavailable",
          checking: false,
          reason: "failed",
          detail: "x".repeat(MAX_PROVIDER_DETAIL),
        },
      ],
    ];
    for (const [fields, expected] of cases) {
      assert.deepStrictEqual(statusOf(claude, fields)?.status, expected);
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
      reason: "not-installed",
      detail: notChecked.message,
    });
    // Past the budget the check failed or died, and the placeholder says nothing more.
    assert.deepStrictEqual(statusOf(claude, notChecked, false)?.status, {
      _tag: "unavailable",
      checking: false,
      reason: "failed",
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

describe("versions and updates", () => {
  const advisory = (fields: Record<string, unknown>) => ({
    status: "behind_latest",
    currentVersion: "2.1.0",
    latestVersion: "2.2.0",
    updateCommand: "claude update",
    canUpdate: true,
    checkedAt: null,
    message: null,
    ...fields,
  });
  const updateState = (
    status: string,
    message: string | null = null,
    finishedAt: string | null = null,
  ) => ({
    status,
    startedAt: null,
    finishedAt,
    message,
    output: null,
  });
  const withRequest = (fields: Record<string, unknown>, request: UpdateRequest | undefined) =>
    providerStatuses(
      [claude],
      reported(claude, fields),
      false,
      request === undefined ? new Map() : new Map([[claude.id, request]]),
    )[0]?.update;

  it("offers a newer version on the terms the engine's own client offers it", () => {
    const behind = { installed: "2.1.0", latest: "2.2.0" };
    const cases: ReadonlyArray<
      readonly [ProviderInstance, Record<string, unknown>, ProviderStatus["version"]]
    > = [
      [claude, { versionAdvisory: advisory({}) }, { ...behind, canUpdate: true }],
      // The engine cannot update it itself, or has no command for it.
      [
        claude,
        { versionAdvisory: advisory({ canUpdate: false }) },
        { ...behind, canUpdate: false },
      ],
      [
        claude,
        { versionAdvisory: advisory({ updateCommand: null }) },
        { ...behind, canUpdate: false },
      ],
      [claude, { enabled: false, versionAdvisory: advisory({}) }, { ...behind, canUpdate: false }],
      // Nothing newer, or a newer version that does not work with the engine.
      [
        claude,
        { versionAdvisory: advisory({ status: "current", latestVersion: "2.1.0" }) },
        { installed: "2.1.0", latest: null, canUpdate: false },
      ],
      [
        claude,
        {
          versionAdvisory: advisory({}),
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus: "broken",
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        },
        { installed: "2.1.0", latest: null, canUpdate: false },
      ],
      // No advisory: the version the check read.
      [claude, { version: "2.0.9" }, { installed: "2.0.9", latest: null, canUpdate: false }],
      // No harness found, and an ACP agent, which has no versions.
      [claude, { installed: false, versionAdvisory: advisory({}) }, undefined],
      [scripted, { versionAdvisory: advisory({}) }, undefined],
    ];
    for (const [provider, fields, version] of cases) {
      assert.deepStrictEqual(
        providerStatuses([provider], reported(provider, fields), false)[0]?.version,
        version,
      );
    }
  });

  it("reports the update asked for, with the engine's state of one running first", () => {
    const askedAt = Date.parse("2026-11-20T12:00:00Z");
    const refused: UpdateRequest = { _tag: "refused", askedAt, detail: "Provider is busy." };
    assert.strictEqual(withRequest({}, undefined), undefined);
    assert.strictEqual(withRequest({ updateState: updateState("idle") }, undefined), undefined);
    // Asked, before the engine reports it.
    assert.deepStrictEqual(withRequest({}, { _tag: "asked", askedAt }), { state: "running" });
    assert.deepStrictEqual(withRequest({ updateState: updateState("succeeded") }, refused), {
      state: "failed",
      detail: "Provider is busy.",
    });
    assert.deepStrictEqual(withRequest({ updateState: updateState("queued") }, refused), {
      state: "running",
    });
    // An update the engine finished after it was asked, whose answer was lost, is the engine's to tell.
    const stopped = "Update stopped before it finished.";
    assert.deepStrictEqual(
      withRequest(
        { updateState: updateState("failed", stopped, "2026-11-20T12:05:00Z") },
        { _tag: "refused", askedAt, detail: null },
      ),
      { state: "failed", detail: stopped },
    );
    assert.deepStrictEqual(
      withRequest(
        { updateState: updateState("succeeded", null, "2026-11-20T11:00:00Z") },
        { _tag: "asked", askedAt },
      ),
      { state: "running" },
    );
    // A request lost on the way, which the engine never reported.
    assert.deepStrictEqual(withRequest({}, { _tag: "refused", askedAt, detail: null }), {
      state: "failed",
    });
    // An update after which the engine no longer finds the harness still says how it went.
    assert.deepStrictEqual(
      withRequest({ installed: false, updateState: updateState("unchanged") }, undefined),
      { state: "unverified" },
    );
    const finished = [
      ["succeeded", { state: "updated", detail: "Updated to 2.2.0." }],
      ["unchanged", { state: "unverified", detail: "Updated to 2.2.0." }],
      ["failed", { state: "failed", detail: "Updated to 2.2.0." }],
    ] as const;
    for (const [status, update] of finished) {
      assert.deepStrictEqual(
        withRequest({ updateState: updateState(status, "Updated to 2.2.0.") }, undefined),
        update,
      );
    }
  });
});

describe("providerProblems", () => {
  it("gives a line for each provider the engine cannot run, and none for one being checked", () => {
    const notFound = "Claude Agent CLI (`claude`) was not found on PATH.";
    assert.deepStrictEqual(
      providerProblems([claude], reported(claude, { installed: false, message: notFound })),
      new Map([[claude.id, `Claude Code: not-installed (${notFound})`]]),
    );
    const notChecked = { installed: false, status: "warning", auth: { status: "unknown" } };
    assert.strictEqual(providerProblems([claude], reported(claude, notChecked)).size, 0);
    assert.strictEqual(providerProblems([claude], reported(claude, {})).size, 0);
  });
});

describe("withoutSecrets", () => {
  it("takes every secret it is given out of the engine's words, whole", () => {
    const key = "sk-proxy-0123456789";
    const engine = reported(claude, {
      status: "error",
      message: `Probe failed: J3_PROVIDER_KEY=${key} and again ${key}; token=${key}-extra`,
      availability: "unavailable",
      unavailableReason: `Could not read ${key}`,
      updateState: {
        status: "failed",
        startedAt: null,
        finishedAt: null,
        message: `npm said ${key}`,
        output: null,
      },
    });
    const [scrubbed] = withoutSecrets(engine, ["", key.slice(0, 6), key, `${key}-extra`]);
    assert.strictEqual(
      scrubbed?.message,
      `Probe failed: J3_PROVIDER_KEY=${REDACTED} and again ${REDACTED}; token=${REDACTED}`,
    );
    assert.strictEqual(scrubbed?.unavailableReason, `Could not read ${REDACTED}`);
    assert.strictEqual(scrubbed?.updateState?.message, `npm said ${REDACTED}`);
  });
});

describe("withFirstCheckBudget", () => {
  it.effect(
    "ends the first check's budget once it passes, and starts it again whenever the engine is ready",
    () =>
      Effect.gen(function* () {
        const states = yield* Queue.unbounded<{ readonly _tag: "ready" | "unavailable" }>();
        const seen = yield* Ref.make<ReadonlyArray<boolean>>([]);
        yield* withFirstCheckBudget(Stream.fromQueue(states)).pipe(
          Stream.runForEach(({ firstCheck }) => Ref.update(seen, (all) => [...all, firstCheck])),
          Effect.forkChild,
        );
        /**
         * What has been emitted, once there are `count` of them, after the
         * stream has had its turns: a budget's timer starts only once the
         * value before it is taken, at the same moment on the clock, and must
         * have started before the clock moves.
         */
        const emitted = (count: number) =>
          Effect.gen(function* () {
            let all = yield* Ref.get(seen);
            while (all.length < count) {
              yield* Effect.yieldNow;
              all = yield* Ref.get(seen);
            }
            for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
            return yield* Ref.get(seen);
          });

        yield* Queue.offer(states, { _tag: "ready" });
        assert.deepStrictEqual(yield* emitted(1), [true]);

        // Down and back before the budget passes: a new budget, counted from then.
        yield* TestClock.adjust("60 seconds");
        yield* Queue.offer(states, { _tag: "unavailable" });
        assert.deepStrictEqual(yield* emitted(2), [true, false]);
        yield* Queue.offer(states, { _tag: "ready" });
        assert.deepStrictEqual(yield* emitted(3), [true, false, true]);
        // 120 seconds since the first time it was ready, 60 since the second.
        yield* TestClock.adjust("60 seconds");
        assert.deepStrictEqual(yield* emitted(3), [true, false, true]);

        // At 90 seconds it passes: a change of its own, with no new state from the engine.
        yield* TestClock.adjust("30 seconds");
        assert.deepStrictEqual(yield* emitted(4), [true, false, true, false]);
      }),
  );
});
