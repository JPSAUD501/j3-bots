// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecentTurns } from "@j3-bots/client-runtime";
import {
  type Bot,
  type BotId,
  ProviderId,
  type ProviderStatus,
  RoutineId,
  type UsageRoutine,
  type UsageTurn,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context } from "../test/fixtures";
import { coverage, providerUsage, windowText } from "./usage";

const claude = ProviderId.make("claude");
const codex = ProviderId.make("codex");

const ana = bot("Ana");
const bia = bot("Bia");
const bots = new Map<BotId, Bot>([
  [ana.id, ana],
  [bia.id, bia],
]);

const digest: UsageRoutine = { _tag: "routine", id: RoutineId.make("digest"), name: "Digest" };

/** A turn that started at `time` on the sample's morning. */
const turn = (
  time: string,
  botId: BotId,
  routine: UsageRoutine | null = null,
  providerId = claude,
): UsageTurn => {
  const startedAt = at(`2026-11-20T${time}:00Z`);
  return { botId, routine, providerId, startedAt, finishedAt: startedAt };
};

const provider = (
  id: ProviderId,
  status: ProviderStatus["status"],
  usage: ProviderStatus["usage"] = [],
): ProviderStatus => ({ id, name: id, harness: "other", status, models: [], usage });

describe("providerUsage", () => {
  it("counts each provider's turns by bot, most first, with each routine's share", () => {
    const turns = [
      turn("10:59", bia.id),
      turn("10:58", ana.id, digest),
      turn("10:57", ana.id),
      turn("10:56", ana.id, { _tag: "deleted" }),
      turn("10:55", ana.id, digest),
      turn("10:54", bia.id, null, codex),
    ];
    const [onClaude, onCodex] = providerUsage(
      [provider(claude, { _tag: "ready" }), provider(codex, { _tag: "ready" })],
      turns,
      bots,
    );
    expect(
      onClaude?.bots.map((spend) => [spend.bot?.profile.name, spend.turns, spend.routines]),
    ).toEqual([
      [
        "Ana",
        4,
        [
          { routine: digest, turns: 2 },
          // Routines deleted since are one share: nothing tells them apart.
          { routine: { _tag: "deleted" }, turns: 1 },
        ],
      ],
      ["Bia", 1, []],
    ]);
    // A bot that moved to another provider counts on each.
    expect(onCodex?.bots.map((spend) => [spend.botId, spend.turns])).toEqual([[bia.id, 1]]);
  });

  it("lists a provider that can run bots, reports a limit or spent turns, and no other", () => {
    const gone = ProviderId.make("gone");
    const listed = providerUsage(
      [
        provider(claude, { _tag: "limited", resetsAt: null }),
        provider(codex, { _tag: "unavailable" }),
        provider(ProviderId.make("signed-out"), { _tag: "sign-in-required", command: "connect" }, [
          { label: "Weekly", usedPercent: 12, resetsAt: null },
        ]),
        provider(ProviderId.make("idle"), { _tag: "unavailable" }),
      ],
      [turn("10:59", ana.id, null, codex), turn("10:58", ana.id, null, gone)],
      new Map(),
    );
    expect(listed.map((p) => [p.id, p.bots.map((spend) => spend.bot)])).toEqual([
      ["claude", []],
      ["codex", [null]],
      ["signed-out", []],
      // One the engine no longer lists, named by its id.
      ["gone", [null]],
    ]);
  });
  it("keys each window apart, also two the engine labels alike", () => {
    const [listed] = providerUsage(
      [
        provider(claude, { _tag: "ready" }, [
          { label: "Weekly", usedPercent: 12, resetsAt: null },
          { label: "Weekly", usedPercent: 40, resetsAt: null },
        ]),
      ],
      [],
      bots,
    );
    const keys = listed?.windows.map((w) => w.key) ?? [];
    expect(new Set(keys).size).toBe(2);
  });
});

describe("coverage", () => {
  const recent = (hasMore: boolean, canLoadMore = hasMore): RecentTurns => ({
    turns: [turn("10:42", ana.id), turn("10:41", ana.id), turn("10:41", bia.id)],
    readAt: at("2026-11-20T11:00:00Z"),
    hasMore,
    canLoadMore,
  });

  it("covers the period when every turn in it is read, else the latest turns read", () => {
    expect(coverage(recent(false))).toEqual({ _tag: "period" });
    expect(coverage(recent(true))).toEqual({
      _tag: "latest",
      count: 3,
      oldest: at("2026-11-20T10:41:00Z"),
      capped: false,
    });
    // More in the period than one read takes.
    expect(coverage(recent(true, false))).toMatchObject({ _tag: "latest", capped: true });
  });
});

describe("windowText", () => {
  // 11:00 in São Paulo, the fixtures' zone.
  const ctx = context("2026-11-20T14:00:00Z");

  it("reads a window at its limit as reached until it resets", () => {
    expect(
      windowText({ label: "Weekly", usedPercent: 100, resetsAt: at("2026-11-20T18:00:00Z") }, ctx),
    ).toMatchObject({ used: "Limit reached", tone: "full", reset: "Resets at 3:00\u00A0PM" });
    // Short of it, never full.
    expect(windowText({ label: "Weekly", usedPercent: 99.6, resetsAt: null }, ctx)).toMatchObject({
      used: "99% used",
      tone: "open",
      reset: null,
    });
  });

  it("past its reset, keeps the last figure and says when it reset", () => {
    expect(
      windowText({ label: "Weekly", usedPercent: 100, resetsAt: at("2026-11-20T13:00:00Z") }, ctx),
    ).toMatchObject({
      used: "100% used",
      tone: "reset",
      reset: "Reset at 10:00\u00A0AM; new figures at the next check",
    });
  });

  it("names the engine's Session the five-hour window, and keeps every other label", () => {
    const named = (label: string, locale: "en" | "pt-BR" = "en") =>
      windowText({ label, usedPercent: 0, resetsAt: null }, context("2026-11-20T14:00:00Z", locale))
        .name;
    expect(named("Session")).toBe("5-hour window");
    expect(named("Session", "pt-BR")).toBe("Janela de 5 horas");
    expect(named("Weekly · Claude Opus 5.5")).toBe("Weekly · Claude Opus 5.5");
  });
});
