// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecentTurns } from "../stores/Usage.ts";
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
import { at, bot } from "../../test/fixtures.ts";
import { coverage, providerUsage, windowState } from "./usage.ts";

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
        provider(codex, { _tag: "unavailable", checking: false }),
        provider(ProviderId.make("signed-out"), { _tag: "sign-in-required", command: "connect" }, [
          { label: "Weekly", usedPercent: 12, resetsAt: null },
        ]),
        provider(ProviderId.make("idle"), { _tag: "unavailable", checking: false }),
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

describe("windowState", () => {
  const now = at("2026-11-20T14:00:00Z");

  it("is full at the limit until it resets, and never short of it", () => {
    const later = at("2026-11-20T18:00:00Z");
    expect(windowState({ label: "Weekly", usedPercent: 100, resetsAt: later }, now)).toEqual({
      percent: 100,
      tone: "full",
      resetsAt: later,
    });
    expect(windowState({ label: "Weekly", usedPercent: 99.6, resetsAt: null }, now)).toEqual({
      percent: 99,
      tone: "open",
      resetsAt: null,
    });
  });

  it("past its reset, reads as reset with the last figure, at the limit or not", () => {
    const earlier = at("2026-11-20T13:00:00Z");
    expect(windowState({ label: "Weekly", usedPercent: 100, resetsAt: earlier }, now)).toEqual({
      percent: 100,
      tone: "reset",
      resetsAt: earlier,
    });
    expect(windowState({ label: "Weekly", usedPercent: 40, resetsAt: now }, now).tone).toBe(
      "reset",
    );
  });
});
