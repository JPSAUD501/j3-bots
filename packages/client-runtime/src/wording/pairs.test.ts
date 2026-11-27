// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Language, pairBotIds, RoomId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { context, teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { pairLine, pairOrder, pairTitle, teamNoticeLine } from "./pairs.ts";

const NOW = "2026-11-20T12:00:00Z";
const names = { scout: "Scout", wren: "Wren" };
const ctx = (locale: Language) => context(NOW, locale, names);

describe("a pair's row", () => {
  const pair = teammatePair(
    teammateMessage(4, "2026-11-20T10:00:00Z", "wren", "scout", "Done.\n\nAll green."),
    4,
  );

  it("is titled with both names in order, and shows the latest message after who wrote it", () => {
    expect(pairTitle(pair.botIds, ctx("en"))).toBe("Scout and Wren");
    expect(pairTitle(pair.botIds, ctx("pt-BR"))).toBe("Scout e Wren");
    expect(pairLine(pair, ctx("en"))).toBe("Wren: Done. All green.");
  });

  it("orders its bots by name, whatever their ids", () => {
    const named = context(NOW, "en", { a: "Wren", b: "Scout" });
    const botIds = pairBotIds(BotId.make("a"), BotId.make("b"));
    expect(pairOrder(botIds, named)).toEqual([BotId.make("b"), BotId.make("a")]);
    expect(pairTitle(botIds, named)).toBe("Scout and Wren");
  });
});

describe("teamNoticeLine", () => {
  const support = RoomId.make("support");
  const team = (roomName: string | null) => ({
    ...ctx("en"),
    roomName: (id: RoomId) => (id === support ? roomName : null),
  });

  it("names the bot and the room apart", () => {
    const started = teamNoticeLine(
      { _tag: "room-started", botId: BotId.make("scout"), roomId: support },
      team("Support"),
    );
    expect(started.text).toBe("Scout started Support");
    expect(started.parts).toContainEqual({ _tag: "room", roomId: support, name: "Support" });
  });

  it("says a room of bots only paused, and that the bot that started it knows", () => {
    const paused = teamNoticeLine(
      { _tag: "room-paused", botId: BotId.make("scout"), roomId: support },
      team("Support"),
    );
    expect(paused.text).toBe(
      "Support paused: its bots talked as long as they may on their own, and Scout was told",
    );
    expect(paused.parts).toContainEqual({ _tag: "room", roomId: support, name: "Support" });
  });

  it("says a room deleted since is a room", () => {
    expect(
      teamNoticeLine(
        { _tag: "made-for-room", botId: BotId.make("scout"), roomId: support },
        team(null),
      ).text,
    ).toBe("Made by Scout for a room");
  });
});
