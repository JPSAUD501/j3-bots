// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandError,
  Conflict,
  EntryId,
  NotFound,
  RoomId,
  SectionId,
  type Bot,
  type EntryPreview,
  type Room,
  type RosterItem,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, preview, teammateMessage, teammatePair } from "../../test/fixtures.ts";
import type { IntentResult } from "../intents/Actions.ts";
import {
  arrangedOrder,
  arrangeRoster,
  betweenBots,
  canStop,
  filterPairs,
  filterRoster,
  orderRoster,
  roomStop,
  roomStopFailed,
} from "./roster.ts";

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
    work: "none",
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
      row(bot("Asking", { _tag: "waiting", entryId: EntryId.make("ask"), since: null })),
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

describe("arrangeRoster", () => {
  const work = { id: SectionId.make("work"), name: "Work" };
  const home = { id: SectionId.make("home"), name: "Home" };
  const gone = SectionId.make("gone");

  it("draws pinned bots apart, sections in their order, and hidden bots only as hidden", () => {
    const arranged = arrangeRoster(
      [
        row(bot("Pinned", { _tag: "idle" }, { pinned: true, sectionId: work.id })),
        row(bot("Ana", { _tag: "idle" }, { sectionId: work.id })),
        room(null),
        row(bot("Loose")),
        row(bot("Orphan", { _tag: "idle" }, { sectionId: gone })),
        row(bot("Away", { _tag: "idle" }, { hidden: true, pinned: true, sectionId: work.id })),
        row(bot("Bia", { _tag: "idle" }, { sectionId: work.id })),
      ],
      [home, work],
    );

    expect(names(arranged.pinned)).toEqual(["Pinned"]);
    expect(names(arranged.main)).toEqual(["Launch", "Loose", "Orphan"]);
    expect(arranged.sections.map(({ section, items }) => [section.name, names(items)])).toEqual([
      ["Home", []],
      ["Work", ["Ana", "Bia"]],
    ]);
    expect(names(arranged.hidden)).toEqual(["Away"]);
    expect(names(arrangedOrder(arranged, () => false))).toEqual([
      "Pinned",
      "Launch",
      "Loose",
      "Orphan",
      "Ana",
      "Bia",
    ]);
    expect(names(arrangedOrder(arranged, (id) => id === work.id))).toEqual([
      "Pinned",
      "Launch",
      "Loose",
      "Orphan",
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
            avatar: { shape: "dome", color: "tomato" },
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

describe("canStop", () => {
  const since = { since: at("2026-11-20T15:00:00Z"), stalled: false, quietSince: null };

  it("offers Stop while a turn runs", () => {
    expect(canStop(bot("Scout", { _tag: "thinking", ...since }))).toBe(true);
    expect(canStop(bot("Scout", { _tag: "working", ...since, activity: null, tool: null }))).toBe(
      true,
    );
  });

  it("offers Stop to a bot at rest whose background work holds a change of its settings", () => {
    expect(canStop(bot("Scout", { _tag: "idle" }, { settingsHeld: true }))).toBe(true);
  });

  it("offers nothing to a bot at rest with nothing held", () => {
    expect(canStop(bot("Scout"))).toBe(false);
  });
});

describe("roomStop", () => {
  const launch: Room = {
    id: RoomId.make("launch"),
    name: "Launch",
    status: "active",
    members: [bot("Scout").id, bot("Wren").id],
    hostId: bot("Scout").id,
    hopLimit: 3,
    pinned: false,
    createdAt: at("2026-11-01T00:00:00Z"),
    work: "none",
  };

  it("offers Stop while the room's work runs, and shows it stopping until the server ends it", () => {
    expect(roomStop({ ...launch, work: "running" })).toBe("offered");
    expect(roomStop({ ...launch, work: "stopping" })).toBe("stopping");
    expect(roomStop(launch)).toBe("hidden");
  });

  it("offers nothing in an archived room, whose archiving stopped its work", () => {
    const archived: Room = {
      ...launch,
      status: "archived",
      archivedAt: at("2026-11-20T15:00:00Z"),
    };
    expect(roomStop(archived)).toBe("hidden");
  });
});

describe("roomStopFailed", () => {
  const refused = (error: CommandError): IntentResult => ({
    _tag: "failed",
    failure: { _tag: "refused", error },
  });

  it("says nothing of a Stop refused because the room was archived meanwhile", () => {
    expect(roomStopFailed(refused(new Conflict({ reason: "room-archived" })))).toBe(false);
    expect(roomStopFailed({ _tag: "done", value: undefined })).toBe(false);
  });

  it("says every other Stop that did not take effect", () => {
    expect(roomStopFailed(refused(new Conflict({ reason: "engine-unavailable" })))).toBe(true);
    expect(roomStopFailed(refused(new NotFound({ resource: "room" })))).toBe(true);
    expect(roomStopFailed({ _tag: "failed", failure: { _tag: "unexpected" } })).toBe(true);
  });
});

describe("the roster's pairs", () => {
  const scoutAndWren = teammatePair(teammateMessage(3, "2026-11-20T10:00:00Z", "wren", "scout"));
  const scoutAndPip = teammatePair(teammateMessage(2, "2026-11-20T09:00:00Z", "scout", "pip"));
  const wrenAndGone = teammatePair(teammateMessage(1, "2026-11-20T08:00:00Z", "wren", "gone"));
  const pairs = [scoutAndWren, scoutAndPip, wrenAndGone];
  const items = [row(bot("Scout")), row(bot("Wren")), row(bot("Pip", undefined, { hidden: true }))];

  it("lists only pairs whose two bots the roster shows, latest first", () => {
    expect(betweenBots(pairs, items)).toEqual([scoutAndWren]);
  });

  it("finds a pair by either name, a hidden bot's too, never a deleted bot's", () => {
    expect(filterPairs(pairs, items, "pip")).toEqual([scoutAndPip]);
    expect(filterPairs(pairs, items, "wre")).toEqual([scoutAndWren]);
    expect(filterPairs(pairs, items, " ")).toEqual([scoutAndWren]);
  });
});
