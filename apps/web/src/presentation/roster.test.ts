// SPDX-License-Identifier: AGPL-3.0-or-later
import { EntryId, RoomId, type Bot, type EntryPreview, type RosterItem } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain, preview } from "../test/fixtures";
import { filterRoster, orderRoster, rosterLine } from "./roster";

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
    hostId: bot("Scout").id,
    hopLimit: 3,
    pinned: false,
    createdAt: at("2026-11-01T00:00:00Z"),
  },
  lastEntry,
  lastActivityAt: lastEntry?.createdAt ?? null,
  unread: false,
});

const names = (items: ReadonlyArray<RosterItem>) =>
  items.map((i) => (i._tag === "bot" ? i.bot.profile.name : i.room.name));

describe("orderRoster", () => {
  it("puts pinned rows first, then rows that need the operator, then the most recent", () => {
    const items = [
      row(bot("Quiet")),
      row(bot("Recent"), preview("2026-11-20T14:00:00Z")),
      row(bot("Older"), preview("2026-11-20T09:00:00Z")),
      row(bot("Unread"), preview("2026-11-19T09:00:00Z"), true),
      row(bot("Asking", { _tag: "waiting", entryId: EntryId.make("ask") })),
      row(bot("Pinned", { _tag: "idle" }, { pinned: true })),
    ];
    expect(names(orderRoster(items))).toEqual([
      "Pinned",
      "Unread",
      "Asking",
      "Recent",
      "Older",
      "Quiet",
    ]);
  });
});

describe("filterRoster", () => {
  const items = [
    row(
      bot(
        "João",
        { _tag: "idle" },
        {
          profile: {
            name: "João",
            title: "Research",
            avatar: { shape: "circle", color: "red" },
            job: "",
          },
        },
      ),
    ),
    row(bot("Pip", { _tag: "idle" }, { hidden: true })),
    room(null),
  ];

  it("keeps hidden bots out until searched for", () => {
    expect(names(filterRoster(items, ""))).toEqual(["João", "Launch"]);
    expect(names(filterRoster(items, "pi"))).toEqual(["Pip"]);
  });

  it("matches names and titles regardless of case and accents", () => {
    expect(names(filterRoster(items, " joao "))).toEqual(["João"]);
    expect(names(filterRoster(items, "RESEARCH"))).toEqual(["João"]);
  });
});

describe("rosterLine", () => {
  it("says what a waiting bot asks, in the waiting tone, and in the past once it no longer waits", () => {
    const question = preview("2026-11-20T14:50:00Z", "question", "Which day?", {
      _tag: "bot",
      botId: bot("Scout").id,
    });
    const waiting = bot("Scout", { _tag: "waiting", entryId: question.entryId });
    expect(rosterLine(row(waiting, question), ctx)).toEqual({
      text: "Asks: Which day?",
      tone: "waiting",
    });
    expect(rosterLine(row(bot("Scout"), question), ctx)).toEqual({
      text: "Asked: Which day?",
      tone: "default",
    });
  });

  it("says a waiting bot needs the operator when its last entry is not what it waits on", () => {
    const waiting = bot("Scout", { _tag: "waiting", entryId: EntryId.make("elsewhere") });
    expect(rosterLine(row(waiting, preview("2026-11-20T14:50:00Z")), ctx)).toEqual({
      text: "Needs you",
      tone: "waiting",
    });
  });

  it("says until when a usage limit holds, in the blocked tone", () => {
    const blocked = bot("Scout", {
      _tag: "blocked",
      failure: "usage-limit",
      retryAt: at("2026-11-20T18:30:00Z"),
    });
    const line = rosterLine(row(blocked), ctx);
    expect({ ...line, text: plain(line.text) }).toEqual({
      text: "Usage limit reached until 3:30 PM",
      tone: "blocked",
    });
  });

  it("says how long a stalled turn has been quiet", () => {
    const stalled = bot("Scout", {
      _tag: "working",
      since: at("2026-11-20T14:48:00Z"),
      stalled: true,
      activity: "Reading",
    });
    expect(rosterLine(row(stalled), ctx)).toEqual({ text: "No activity for 12m", tone: "waiting" });
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
