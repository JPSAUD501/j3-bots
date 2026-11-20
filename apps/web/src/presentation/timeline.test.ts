// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, EntryOrder } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, message } from "../test/fixtures";
import { buildTimeline } from "./timeline";

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const wren = { _tag: "bot", botId: BotId.make("wren") } as const;
const shape = (items: ReturnType<typeof buildTimeline>) =>
  items.map((i) => (i.kind === "message" ? i.position : i.kind));

describe("buildTimeline", () => {
  it("groups one author's messages that follow closely", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z", scout),
      message("2026-11-20T10:01:00Z", scout),
      message("2026-11-20T10:02:00Z", scout),
      message("2026-11-20T10:03:00Z", wren),
      message("2026-11-20T10:04:00Z"),
    ]);
    expect(shape(items)).toEqual(["divider", "first", "middle", "last", "single", "single"]);
  });

  it("breaks a group after a pause and puts the time between long ones", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z"),
      message("2026-11-20T10:06:00Z"),
      message("2026-11-20T10:30:00Z"),
    ]);
    expect(shape(items)).toEqual(["divider", "single", "single", "divider", "single"]);
    expect(items[3]?.kind === "divider" && items[3].at).toEqual(at("2026-11-20T10:30:00Z"));
  });

  it("does not join messages across a card", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z", scout),
      {
        _tag: "handoff",
        id: EntryId.make("handoff"),
        order: EntryOrder.make(1),
        author: scout,
        createdAt: at("2026-11-20T10:00:30Z"),
        recipientId: BotId.make("wren"),
        text: "Over to you",
        urgent: false,
      },
      message("2026-11-20T10:01:00Z", scout),
    ]);
    expect(shape(items)).toEqual(["divider", "single", "card", "single"]);
  });
});
