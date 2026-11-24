// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { handoff, message, teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { buildPairTimeline, conversationRowOrder, teammatesOf, withTeammateRuns } from "./pairs.ts";
import { buildTimeline } from "./timeline.ts";

const shape = (rows: ReturnType<typeof withTeammateRuns>) =>
  rows.map((row) => (row.kind === "teammates" ? `teammates×${row.run.entries.length}` : row.kind));

describe("withTeammateRuns", () => {
  it("makes consecutive teammate cards one row, and anything between them ends it", () => {
    const rows = withTeammateRuns(
      buildTimeline([
        message("2026-11-20T10:00:00Z"),
        handoff("2026-11-20T10:01:00Z", "scout", "wren", "sent"),
        handoff("2026-11-20T10:02:00Z", "scout", "wren", "received"),
        message("2026-11-20T10:03:00Z", { _tag: "bot", botId: BotId.make("scout") }),
        handoff("2026-11-20T10:04:00Z", "scout", "wren", "sent"),
      ]),
    );
    expect(shape(rows)).toEqual(["divider", "message", "teammates×2", "message", "teammates×1"]);
  });

  it("drops a time between two cards of a run, and keeps the one before it", () => {
    const first = handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent");
    const rows = withTeammateRuns(
      buildTimeline([
        first,
        handoff("2026-11-20T13:00:00Z", "scout", "wren", "received"),
        message("2026-11-20T18:00:00Z"),
      ]),
    );
    expect(shape(rows)).toEqual(["divider", "teammates×2", "divider", "message"]);
    // The row keeps the first card's key, so its element stays as the run grows.
    expect(rows[1]?.key).toBe(first.id);
  });

  it("lists each teammate of a run once, in the order met, with where its conversation opens", () => {
    const toWren = handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent");
    const fromPip = handoff("2026-11-20T10:01:00Z", "scout", "pip", "received", "not-delivered");
    const rows = withTeammateRuns(
      buildTimeline([
        toWren,
        fromPip,
        handoff("2026-11-20T10:02:00Z", "scout", "wren", "received", "stopped"),
      ]),
    );
    const row = rows.find((r) => r.kind === "teammates");
    if (row?.kind !== "teammates") return expect.fail("The cards were not made a run");
    expect(row.run.direction).toBe("both");
    expect(row.run.undelivered).toBe(2);
    expect(row.run.pairs).toEqual([
      { peer: "wren", botIds: ["scout", "wren"], first: toWren.id, count: 2 },
      { peer: "pip", botIds: ["pip", "scout"], first: fromPip.id, count: 1 },
    ]);
  });

  it("reads a run through its newest card", () => {
    const rows = withTeammateRuns(
      buildTimeline([
        handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent"),
        handoff("2026-11-20T10:01:00Z", "scout", "wren", "received"),
      ]),
    );
    const run = rows.find((r) => r.kind === "teammates");
    if (run?.kind !== "teammates") return expect.fail("The cards were not made a run");
    expect(conversationRowOrder(run)).toBe(run.run.entries.at(-1)?.order);
  });
});

describe("buildPairTimeline", () => {
  it("groups each bot's messages under its name, with a time between quiet stretches", () => {
    const rows = buildPairTimeline([
      teammateMessage(1, "2026-11-04T10:35:00Z", "scout", "wren"),
      teammateMessage(2, "2026-11-04T10:36:00Z", "scout", "wren"),
      teammateMessage(3, "2026-11-04T10:40:00Z", "wren", "scout"),
      teammateMessage(4, "2026-11-12T13:19:00Z", "wren", "scout"),
    ]);
    expect(rows.map((row) => (row.kind === "message" ? row.position : row.kind))).toEqual([
      "divider",
      "first",
      "last",
      "single",
      "divider",
      "single",
    ]);
  });
});

describe("teammatesOf", () => {
  it("lists every pair a bot is in, with the other bot, whatever became of it", () => {
    const withWren = teammatePair(teammateMessage(5, "2026-11-20T10:00:00Z", "wren", "scout"));
    const withDeleted = teammatePair(teammateMessage(3, "2026-11-19T10:00:00Z", "scout", "gone"));
    const others = teammatePair(teammateMessage(4, "2026-11-19T11:00:00Z", "wren", "pip"));
    expect(teammatesOf(BotId.make("scout"), [withWren, others, withDeleted])).toEqual([
      { pair: withWren, peer: "wren" },
      { pair: withDeleted, peer: "gone" },
    ]);
  });
});
