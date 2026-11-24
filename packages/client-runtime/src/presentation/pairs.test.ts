// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { buildPairTimeline, teammatesOf } from "./pairs.ts";

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
