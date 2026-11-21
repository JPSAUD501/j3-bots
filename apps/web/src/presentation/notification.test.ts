// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, RoomId, type Notification } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { context } from "../test/fixtures";
import { notificationContent } from "./notification";

const scout = BotId.make("scout");
const launch = RoomId.make("launch");
const rooms = (id: RoomId) => (id === launch ? "Launch" : null);

const notification = (extra: Partial<Notification>): Notification => ({
  target: { _tag: "conversation", botId: scout },
  entryId: EntryId.make("e1"),
  botId: scout,
  kind: "message",
  preview: null,
  ...extra,
});

describe("notificationContent", () => {
  const ctx = context("2026-11-20T15:00:00Z", "en", { scout: "Scout" });

  it("comes from the bot, and says only what arrived unless previews are allowed", () => {
    expect(notificationContent(notification({ kind: "approval" }), ctx, rooms)).toEqual({
      title: "Scout",
      body: "Needs your approval",
    });
    expect(
      notificationContent(notification({ kind: "question", preview: "Ship it?" }), ctx, rooms),
    ).toEqual({ title: "Scout", body: "Asks: Ship it?" });
  });

  it("comes from the room, naming the bot, for what was said in one", () => {
    const inRoom = notification({ target: { _tag: "room", roomId: launch }, preview: "Done" });
    expect(notificationContent(inRoom, ctx, rooms)).toEqual({
      title: "Launch",
      body: "Scout: Done",
    });
  });

  it("shows nothing for a bot or a room this window no longer lists", () => {
    const gone = context("2026-11-20T15:00:00Z", "en", {});
    expect(notificationContent(notification({}), gone, rooms)).toBeNull();
    const elsewhere = notification({ target: { _tag: "room", roomId: RoomId.make("old") } });
    expect(notificationContent(elsewhere, ctx, rooms)).toBeNull();
  });
});
