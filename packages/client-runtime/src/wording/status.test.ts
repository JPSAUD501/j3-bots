// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, RoomId, type Bot, type EntryPreview, type RosterItem } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain, preview } from "../../test/fixtures.ts";
import { presenceLine, quietConversationText, rosterLine } from "./status.ts";

const ctx = context("2026-11-20T15:00:00Z", "en", { scout: "Scout", wren: "Wren" });

const row = (b: Bot, lastEntry: EntryPreview | null = null, unread = false): RosterItem => ({
  _tag: "bot",
  bot: b,
  lastEntry,
  lastActivityAt: lastEntry?.createdAt ?? null,
  unread,
});

const room = (lastEntry: EntryPreview | null): RosterItem => ({
  _tag: "room",
  room: {
    id: RoomId.make("launch"),
    name: "Launch",
    status: "active",
    members: [bot("Scout").id, bot("Wren").id],
    pinned: false,
    hidden: false,
    createdAt: at("2026-11-01T00:00:00Z"),
    work: "none",
    answering: [],
    memberWork: [],
  },
  lastEntry,
  lastActivityAt: lastEntry?.createdAt ?? null,
  unread: false,
});

describe("rosterLine", () => {
  it("says what a waiting bot asks, in the waiting tone, and in the past once it no longer waits", () => {
    const question = preview("2026-11-20T14:50:00Z", "question", "Which day?", {
      _tag: "bot",
      botId: bot("Scout").id,
    });
    const waiting = bot("Scout", { _tag: "waiting", entryId: question.entryId, since: null });
    expect(rosterLine(row(waiting, question), ctx)).toEqual({
      text: "Asks: Which day?",
      tone: "waiting",
    });
    expect(rosterLine(row(bot("Scout"), question), ctx)).toEqual({
      text: "Asked: Which day?",
      tone: "default",
    });
  });

  it("names the other bot of a teammate message, received or sent", () => {
    const scout = bot("Scout").id;
    const wren = bot("Wren").id;
    const fromWren = preview(
      "2026-11-20T14:50:00Z",
      "handoff",
      "Which bike?",
      { _tag: "bot", botId: wren },
      scout,
    );
    expect(rosterLine(row(bot("Scout"), fromWren), ctx).text).toBe("From Wren: Which bike?");
    const toWren = preview(
      "2026-11-20T14:50:00Z",
      "handoff",
      "Which bike?",
      { _tag: "bot", botId: scout },
      wren,
    );
    expect(rosterLine(row(bot("Scout"), toWren), ctx).text).toBe("To Wren: Which bike?");
  });

  it("names the room a bot was made for as it is called now, and a deleted one as a room", () => {
    const made: EntryPreview = {
      ...preview("2026-11-20T14:50:00Z", "notice", "", { _tag: "system" }),
      notice: { _tag: "made-for-room", botId: bot("Scout").id, roomId: RoomId.make("launch") },
    };
    const renamed = context(
      "2026-11-20T15:00:00Z",
      "en",
      { scout: "Scout" },
      { launch: "Go-live" },
    );
    expect(rosterLine(row(bot("Wren"), made), renamed).text).toBe("Made by Scout for Go-live");
    expect(rosterLine(row(bot("Wren"), made), ctx).text).toBe("Made by Scout for a room");
  });

  it("says a waiting bot needs the operator when its last entry is not what it waits on", () => {
    const waiting = bot("Scout", {
      _tag: "waiting",
      entryId: EntryId.make("elsewhere"),
      since: null,
    });
    expect(rosterLine(row(waiting, preview("2026-11-20T14:50:00Z")), ctx)).toEqual({
      text: "Needs you",
      tone: "waiting",
    });
  });

  it("leads a usage limit with when it resets, in the blocked tone, with the day when it is not today", () => {
    const limited = (retryAt: string | null) =>
      bot("Scout", {
        _tag: "blocked",
        failure: "usage-limit",
        retryAt: retryAt === null ? null : at(retryAt),
      });
    const line = rosterLine(row(limited("2026-11-20T18:30:00Z")), ctx);
    expect({ ...line, text: plain(line.text) }).toEqual({
      text: "Limit resets at 3:30 PM",
      tone: "blocked",
    });
    expect(plain(rosterLine(row(limited("2026-11-21T12:00:00Z")), ctx).text)).toBe(
      "Limit resets tomorrow at 9:00 AM",
    );
    expect(plain(rosterLine(row(limited("2026-11-23T12:00:00Z")), ctx).text)).toBe(
      "Limit resets Monday at 9:00 AM",
    );
    expect(rosterLine(row(limited(null)), ctx).text).toBe("Usage limit reached");
    const pt = context("2026-11-20T15:00:00Z", "pt-BR");
    expect(plain(rosterLine(row(limited("2026-11-20T19:15:00Z")), pt).text)).toBe(
      "Limite renova às 16:15",
    );
    // The conversation header has the room for the whole sentence.
    expect(plain(presenceLine(limited("2026-11-21T12:00:00Z"), pt)?.text ?? "")).toBe(
      "Limite de uso atingido, renova amanhã às 09:00",
    );
  });

  it("keeps a new bot getting ready through the idle moment before its first turn", () => {
    const opening = bot("Scout", { _tag: "idle" }, { opening: true });
    const thinking = bot("Scout", {
      _tag: "thinking",
      since: at("2026-11-20T14:59:00Z"),
      stalled: false,
      quietSince: null,
      typing: false,
    });
    const quiet = [opening, thinking, opening].map((b) => quietConversationText(b, ctx));
    expect(new Set(quiet).size).toBe(1);
    expect(quiet[0]).not.toBe(quietConversationText(bot("Scout"), ctx));
    expect(rosterLine(row(opening), ctx).text).not.toBe(rosterLine(row(bot("Scout")), ctx).text);
  });

  it("never says a blocked bot is getting ready, whatever its opening", () => {
    const blocked = bot(
      "Scout",
      { _tag: "blocked", failure: "usage-limit", retryAt: null },
      { opening: true },
    );
    expect(quietConversationText(blocked, ctx)).toBe(
      quietConversationText(bot("Scout", blocked.state), ctx),
    );
    expect(rosterLine(row(blocked), ctx).tone).toBe("blocked");
  });

  it("says a bot is typing while its next message waits, over what its turn is doing", () => {
    const typing = (state: "thinking" | "working") =>
      bot(
        "Scout",
        state === "thinking"
          ? {
              _tag: "thinking",
              since: at("2026-11-20T14:59:50Z"),
              stalled: false,
              quietSince: null,
              typing: true,
            }
          : {
              _tag: "working",
              since: at("2026-11-20T14:59:50Z"),
              stalled: false,
              quietSince: null,
              typing: true,
              activity: "Reading",
              tool: null,
              littleOnes: 0,
            },
      );
    for (const state of ["thinking", "working"] as const) {
      expect(presenceLine(typing(state), ctx)).toEqual({ text: "Typing", tone: "default" });
      expect(rosterLine(row(typing(state)), ctx).text).toBe("Typing");
    }
  });

  it("says how long a stalled turn has been quiet, from its last activity, not its start", () => {
    const stalled = (quietSince: string | null) =>
      bot("Scout", {
        _tag: "working",
        since: at("2026-11-20T14:20:00Z"),
        stalled: true,
        quietSince: quietSince === null ? null : at(quietSince),
        typing: false,
        activity: "Reading",
        tool: null,
        littleOnes: 0,
      });
    expect(rosterLine(row(stalled("2026-11-20T14:48:00Z")), ctx)).toEqual({
      text: "No activity for 12m",
      tone: "waiting",
    });
    // A server that does not say when it went quiet: no duration to give.
    expect(rosterLine(row(stalled(null)), ctx)).toEqual({
      text: "No recent activity",
      tone: "waiting",
    });
  });

  it("shows the last thing said, with who said it in a room", () => {
    const fromYou = preview("2026-11-20T14:00:00Z", "message", "Look at\n```\ncode\n```\nthis");
    expect(rosterLine(row(bot("Scout"), fromYou), ctx).text).toBe("You: Look at this");
    const wren = { _tag: "bot", botId: bot("Wren").id } as const;
    const inRoom = preview("2026-11-20T14:00:00Z", "message", "Drafted it", wren);
    expect(rosterLine(room(inRoom), ctx).text).toBe("Wren: Drafted it");
    const files = preview("2026-11-20T14:00:00Z", "message", "", wren);
    expect(rosterLine(row(bot("Wren"), files), ctx).text).toBe("Sent files");
  });
});
