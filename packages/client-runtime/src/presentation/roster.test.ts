// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EntryId,
  RoomId,
  type Bot,
  type EntryPreview,
  type Room,
  type RosterItem,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, preview } from "../../test/fixtures.ts";
import { filterRoster, orderRoster, roomStop } from "./roster.ts";

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

describe("roomStop", () => {
  const since = { since: at("2026-11-20T14:00:00Z"), stalled: false };
  const scout = bot("Scout");
  const wren = bot("Wren");
  const launch: Room = {
    id: RoomId.make("launch"),
    name: "Launch",
    status: "active",
    members: [scout.id, wren.id],
    hostId: scout.id,
    hopLimit: 3,
    pinned: false,
    createdAt: at("2026-11-01T00:00:00Z"),
  };
  const working = (b: Bot): Bot => ({ ...b, state: { _tag: "working", ...since, activity: null } });

  it("offers Stop while a member thinks or works", () => {
    expect(roomStop(launch, [scout, working(wren)], false)).toBe("offered");
    expect(roomStop(launch, [{ ...scout, state: { _tag: "thinking", ...since } }], false)).toBe(
      "offered",
    );
  });

  it("offers nothing while no member runs a turn, whatever else is busy", () => {
    const waiting: Bot = { ...scout, state: { _tag: "waiting", entryId: EntryId.make("ask") } };
    const held: Bot = { ...wren, settingsHeld: true };
    expect(roomStop(launch, [waiting, held, working(bot("Outsider"))], false)).toBe("hidden");
  });

  it("shows the Stop on its way until the server answers, then follows the members again", () => {
    expect(roomStop(launch, [scout, wren], true)).toBe("stopping");
    expect(roomStop(launch, [scout, wren], false)).toBe("hidden");
    expect(roomStop(launch, [working(scout), wren], false)).toBe("offered");
  });

  it("offers nothing in an archived room, whose archiving stopped its work", () => {
    const archived: Room = {
      ...launch,
      status: "archived",
      archivedAt: at("2026-11-20T15:00:00Z"),
    };
    expect(roomStop(archived, [working(scout)], false)).toBe("hidden");
    expect(roomStop(archived, [working(scout)], true)).toBe("hidden");
  });
});
