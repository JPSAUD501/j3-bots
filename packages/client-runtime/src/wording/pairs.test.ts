// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Language, RoomId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { context, handoff, teammateMessage, teammatePair } from "../../test/fixtures.ts";
import { withTeammateRuns } from "../presentation/pairs.ts";
import { buildTimeline } from "../presentation/timeline.ts";
import type { HandoffEntry } from "@j3-bots/contracts";
import { pairLine, pairTitle, teammateRunLine, teamNoticeLine } from "./pairs.ts";

const NOW = "2026-11-20T12:00:00Z";
const names = { scout: "Scout", wren: "Wren", pip: "Pip" };
const ctx = (locale: Language) => context(NOW, locale, names);

/** The line of the one run `cards` make. */
const line = (locale: Language, ...cards: ReadonlyArray<HandoffEntry>) => {
  const row = withTeammateRuns(buildTimeline(cards)).find((r) => r.kind === "teammates");
  if (row?.kind !== "teammates") throw new Error("The cards were not made a run");
  return teammateRunLine(row.run, ctx(locale));
};

describe("teammateRunLine", () => {
  it("says one message by who wrote it", () => {
    expect(line("en", handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent")).text).toBe(
      "Wrote to Wren",
    );
    expect(line("pt-BR", handoff("2026-11-20T10:00:00Z", "scout", "wren", "received")).text).toBe(
      "Wren escreveu",
    );
  });

  it("counts an exchange, and draws each teammate's name apart", () => {
    const talked = line(
      "en",
      handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent"),
      handoff("2026-11-20T10:01:00Z", "scout", "wren", "received"),
      handoff("2026-11-20T10:02:00Z", "scout", "pip", "sent"),
    );
    expect(talked.text).toBe("Talked with Wren and Pip · 3 messages");
    expect(talked.parts.filter((part) => typeof part !== "string")).toEqual([
      { _tag: "bot", botId: "wren", name: "Wren" },
      { _tag: "bot", botId: "pip", name: "Pip" },
    ]);
    expect(talked.mark).toBeNull();
  });

  it("agrees the verb with several teammates in Portuguese", () => {
    expect(
      line(
        "pt-BR",
        handoff("2026-11-20T10:00:00Z", "scout", "wren", "received"),
        handoff("2026-11-20T10:01:00Z", "scout", "pip", "received"),
      ).text,
    ).toBe("Wren e Pip escreveram · 2 mensagens");
  });

  it("marks the messages that never reached their teammate", () => {
    const run = (locale: Language) =>
      line(
        locale,
        handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent", "not-delivered"),
        handoff("2026-11-20T10:01:00Z", "scout", "wren", "sent", "stopped"),
      );
    expect(run("en")).toMatchObject({
      text: "Wrote to Wren · 2 messages",
      mark: "2 not delivered",
    });
    expect(run("pt-BR").mark).toBe("2 não entregues");
  });

  it("names a deleted teammate as one", () => {
    expect(line("en", handoff("2026-11-20T10:00:00Z", "scout", "gone", "received")).text).toBe(
      "A deleted bot wrote",
    );
  });
});

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

  it("says a room deleted since is a room", () => {
    expect(
      teamNoticeLine(
        { _tag: "made-for-room", botId: BotId.make("scout"), roomId: support },
        team(null),
      ).text,
    ).toBe("Made by Scout for a room");
  });
});
