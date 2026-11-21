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
import { at, bot } from "../test/fixtures";
import { counted, providerUsage } from "./usage";

const claude = ProviderId.make("claude");
const codex = ProviderId.make("codex");

const ana = bot("Ana");
const bia = bot("Bia");
const bots = new Map<BotId, Bot>([
  [ana.id, ana],
  [bia.id, bia],
]);

const digest: UsageRoutine = { _tag: "routine", id: RoutineId.make("digest"), name: "Digest" };

let minute = 59;
/** A turn, each one older than the one before, as the server lists them. */
const turn = (
  botId: BotId,
  routine: UsageRoutine | null = null,
  providerId = claude,
): UsageTurn => {
  const startedAt = at(`2026-11-20T10:${String(minute--).padStart(2, "0")}:00Z`);
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
      turn(bia.id),
      turn(ana.id, digest),
      turn(ana.id),
      turn(ana.id, { _tag: "deleted" }),
      turn(ana.id, digest),
      turn(bia.id, null, codex),
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
          { key: "digest", name: "Digest", turns: 2 },
          // Routines deleted since are one share: nothing tells them apart.
          { key: "deleted", name: null, turns: 1 },
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
      [turn(ana.id, null, codex), turn(ana.id, null, gone)],
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
});

describe("counted", () => {
  const recent = (hasMore: boolean): RecentTurns => ({
    turns: [turn(ana.id), turn(ana.id)],
    since: at("2026-11-19T11:00:00Z"),
    hasMore,
    canLoadMore: hasMore,
    loadingMore: false,
  });

  it("covers the period when every turn in it is read, else the turns since the oldest read", () => {
    expect(counted(recent(false))).toEqual({ _tag: "period" });
    const partial = recent(true);
    expect(counted(partial)).toEqual({ _tag: "since", at: partial.turns[1]?.startedAt });
  });
});
