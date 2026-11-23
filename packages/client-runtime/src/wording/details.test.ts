// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  MemoryPath,
  ModelId,
  type ProviderStatus,
  ProviderId,
  type Routine,
  RoutineId,
  type RoutineRun,
  RoutineRunId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { createI18n } from "@j3-bots/i18n";
import { memoryFileName, routineLines, routineRunLines } from "./details.ts";
import { providerLine } from "./engine.ts";

const en = context("2026-11-20T17:40:00Z");

const routine = (change: Partial<Routine>): Routine => ({
  id: RoutineId.make("r"),
  botId: BotId.make("b"),
  name: "Digest",
  instruction: "Sum up the day.",
  trigger: { _tag: "schedule", cron: "0 9 * * *", timeZone: "America/Sao_Paulo" },
  enabled: true,
  webhookUrl: null,
  nextRunAt: null,
  lastRun: null,
  runCount: 0,
  ...change,
});

const run = (status: NonNullable<Routine["lastRun"]>["status"]): Routine["lastRun"] => ({
  id: RoutineRunId.make("run"),
  startedAt: at("2026-11-20T12:00:00Z"),
  finishedAt: null,
  status,
  attempts: 1,
  delivered: [],
  note: null,
});

describe("routineLines", () => {
  it("says a schedule in words, or shows its expression when it has none", () => {
    expect(routineLines(routine({}), en)).toMatchObject({
      schedule: "Every day at 9:00 AM",
      expression: false,
    });
    const uneven = { _tag: "schedule", cron: "*/7 * * * *", timeZone: "UTC" } as const;
    expect(routineLines(routine({ trigger: uneven }), en)).toMatchObject({
      schedule: "*/7 * * * *",
      expression: true,
    });
  });

  it("says a paused routine is paused before when it would run next", () => {
    const next = at("2026-11-21T12:00:00Z");
    expect(routineLines(routine({ enabled: false, nextRunAt: next }), en).status).toBe("Paused");
    expect(plain(routineLines(routine({ nextRunAt: next }), en).status ?? "")).toMatch(
      /^Next run /,
    );
    expect(routineLines(routine({}), en).status).toBeNull();
  });

  it("says what the last run did, and marks only a failure", () => {
    expect(routineLines(routine({}), en).lastRun).toBeNull();
    const failed = routineLines(routine({ lastRun: run("failed") }), en).lastRun;
    expect(failed?.failed).toBe(true);
    expect(failed?.text).toMatch(/^Last run failed /);
    expect(routineLines(routine({ lastRun: run("delivered") }), en).lastRun?.failed).toBe(false);
  });
});

describe("routineRunLines", () => {
  const ran = (change: Partial<RoutineRun>): RoutineRun => ({
    id: RoutineRunId.make("run"),
    startedAt: at("2026-11-20T12:00:00Z"),
    finishedAt: at("2026-11-20T12:01:00Z"),
    status: "delivered",
    attempts: 1,
    delivered: [],
    note: null,
    ...change,
  });

  it("says why a run failed in plain words, and marks it", () => {
    expect(routineRunLines(ran({ status: "failed" }), en)).toMatchObject({
      status: "Failed",
      reason: "It ended before it said anything.",
      failed: true,
    });
    const refused = ran({
      status: "failed",
      failure: { _tag: "permission-mode-refused", permissionMode: "full-access", allowed: "auto" },
    });
    expect(routineRunLines(refused, en).reason).toBe(
      "A policy on the computer running J3 Bots allows up to Auto, not Full access.",
    );
  });

  it("says why a run was skipped, and gives no reason for one that reported back", () => {
    expect(routineRunLines(ran({ status: "skipped", attempts: 0 }), en)).toMatchObject({
      status: "Skipped",
      reason: "The run before was still going.",
      failed: false,
    });
    expect(routineRunLines(ran({}), en).reason).toBeNull();
  });

  it("counts the attempts only once a run took more than one", () => {
    expect(routineRunLines(ran({}), en).attempts).toBeNull();
    expect(routineRunLines(ran({ status: "failed", attempts: 3 }), en).attempts).toBe(
      "Tried 3 times",
    );
  });
});

const provider = (change: Partial<ProviderStatus>): ProviderStatus => ({
  id: ProviderId.make("p"),
  name: "Claude",
  harness: "claude-code",
  status: { _tag: "ready" },
  models: [{ id: ModelId.make("m"), name: "Opus" }],
  usage: [],
  ...change,
});

describe("providerLine", () => {
  it("tells ready from waiting, blocked and out of use", () => {
    expect(providerLine(provider({}), en)).toEqual({ text: "Ready", tone: "ready" });
    expect(providerLine(provider({ models: [] }), en).tone).toBe("waiting");
    expect(
      providerLine(provider({ status: { _tag: "sign-in-required", command: "j3 connect" } }), en),
    ).toEqual({ text: "Not connected", tone: "waiting" });
    expect(providerLine(provider({ status: { _tag: "limited", resetsAt: null } }), en)).toEqual({
      text: "Usage limit reached",
      tone: "blocked",
    });
    expect(
      providerLine(provider({ status: { _tag: "unavailable", checking: false } }), en).tone,
    ).toBe("muted");
  });

  it("says a provider the engine has not finished checking is being checked, not unavailable", () => {
    expect(providerLine(provider({ status: { _tag: "unavailable", checking: true } }), en)).toEqual(
      { text: "Checking…", tone: "waiting" },
    );
  });
});

describe("memoryFileName", () => {
  const name = (path: string, language: "en" | "pt-BR" = "en") =>
    memoryFileName(MemoryPath.make(path), createI18n(language));

  it("names a month's log by the month in words, in the operator's language", () => {
    expect(name("log/2026-11.md")).toBe("Notes from November 2026");
    expect(name("log/2026-01.md", "pt-BR")).toBe("Anotações de janeiro de 2026");
  });

  it("names the profile, and shows any other file by its path", () => {
    expect(name("profile.md")).toBe("Profile");
    expect(name("log/2026-13.md")).toBe("log/2026-13.md");
    expect(name("notes/ideas.md")).toBe("notes/ideas.md");
  });
});
