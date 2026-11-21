// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandError,
  Conflict,
  EntryId,
  NotFound,
  RoomId,
  type Bot,
  type EntryPreview,
  type Room,
  type RosterItem,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, preview } from "../../test/fixtures.ts";
import type { IntentResult } from "../intents/Actions.ts";
import { filterRoster, orderRoster, roomStop, roomStopFailed } from "./roster.ts";

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
