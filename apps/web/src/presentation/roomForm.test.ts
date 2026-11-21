// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId, type Room } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../test/fixtures";
import {
  blankRoomForm,
  followRoom,
  hostOf,
  roomChanges,
  roomDraft,
  type RoomFormContext,
  roomFormContext,
  roomFormOf,
  roomFormTarget,
  type RoomFormValues,
  sameRoomForm,
  withMember,
  withoutDeleted,
} from "./roomForm";

const hal = BotId.make("hal");
const scout = BotId.make("scout");
const ana = BotId.make("ana");
const bo = BotId.make("bo");
const cy = BotId.make("cy");
const di = BotId.make("di");
const ed = BotId.make("ed");
const fy = BotId.make("fy");

const form = (change: Partial<RoomFormValues>): RoomFormValues => ({
  ...blankRoomForm,
  name: "Launch",
  ...change,
});

const room: Room = {
  id: RoomId.make("launch"),
  name: "Launch",
  status: "active",
  members: [hal, ana],
  hostId: hal,
  hopLimit: 4,
  pinned: false,
  createdAt: at("2026-11-01T00:00:00Z"),
};

/** How the form reads a room with a host, with `primaryId` as the primary bot and a default hop limit of 4. */
const hosted = (primaryId: BotId | null = null): RoomFormContext =>
  roomFormContext(room, primaryId, 4);

describe("hostOf", () => {
  it("keeps the host picked while it is a member, else the primary bot, else the first member", () => {
    expect(hostOf(form({ members: [ana, hal], hostPick: hal }), hosted(bo))).toBe(hal);
    expect(hostOf(form({ members: [ana, hal], hostPick: bo }), hosted(hal))).toBe(hal);
    expect(hostOf(form({ members: [ana, hal], hostPick: null }), hosted(bo))).toBe(ana);
    expect(hostOf(form({ members: [] }), hosted(hal))).toBeNull();
  });
});

describe("withMember", () => {
  it("adds in the order picked, removes, and takes no seventh bot", () => {
    const six = form({ members: [hal, ana, bo, cy, di, ed] });
    expect(withMember(six, fy, true)).toBe(six);
    expect(withMember(six, ana, false).members).toEqual([hal, bo, cy, di, ed]);
    expect(withMember(form({ members: [ana] }), hal, true).members).toEqual([ana, hal]);
  });
});

describe("roomDraft", () => {
  const creating = (primaryId: BotId | null) => roomFormContext(null, primaryId, null);

  it("needs a name and two to six bots", () => {
    const checked = roomDraft(form({ name: "  ", members: [hal] }), creating(null));
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["name", "members"]);
  });

  it("leaves an empty hop limit to the server's default, and refuses one that is not a whole number", () => {
    expect(roomDraft(form({ name: " Launch ", members: [ana, hal] }), creating(hal))).toEqual({
      _tag: "ready",
      value: { name: "Launch", members: [ana, hal], hostId: hal },
    });
    const checked = roomDraft(form({ members: [ana, hal], hopLimit: "0" }), creating(null));
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });
});

describe("roomChanges", () => {
  const opened = roomFormOf(room);

  it("sends only what changed from the form as it opened, and a host that follows when its bot leaves", () => {
    expect(roomChanges(opened, { ...opened, members: [ana, bo] }, hosted())).toEqual({
      _tag: "ready",
      value: { members: [ana, bo], hostId: ana },
    });
    // Fields left as they opened are not sent, so a change made elsewhere meanwhile stands.
    expect(roomChanges(opened, { ...opened, hopLimit: "5" }, hosted())).toEqual({
      _tag: "ready",
      value: { hopLimit: 5 },
    });
  });

  it("finds nothing to send for an edit the operator undid", () => {
    const undone = { ...opened, name: " Launch ", members: [hal, ana], hostPick: hal };
    expect(sameRoomForm(opened, undone, hosted())).toBe(true);
    expect(roomChanges(opened, undone, hosted())).toEqual({ _tag: "ready", value: {} });
    expect(sameRoomForm(opened, { ...opened, members: [ana, hal] }, hosted())).toBe(false);
  });

  it("sets an emptied hop limit back to the default, which must be known", () => {
    const values = { ...opened, hopLimit: "" };
    expect(roomChanges(opened, values, roomFormContext(room, null, 6))).toEqual({
      _tag: "ready",
      value: { hopLimit: 6 },
    });
    const checked = roomChanges(opened, values, roomFormContext(room, null, null));
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });

  it("asks for a host the server has none of, as for an archived room whose host was deleted", () => {
    const archived: Room = {
      ...room,
      status: "archived",
      members: [hal],
      hostId: null,
      archivedAt: at("2026-11-02T00:00:00Z"),
    };
    const hostless = roomFormContext(archived, hal, 4);
    const opened = roomFormOf(archived);
    const values = withMember(opened, scout, true);
    // Not even the primary bot hosts until the operator picks.
    expect(hostOf(values, hostless)).toBeNull();
    const checked = roomChanges(opened, values, hostless);
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["host"]);
    expect(roomChanges(opened, { ...values, hostPick: scout }, hostless)).toEqual({
      _tag: "ready",
      value: { members: [hal, scout], hostId: scout },
    });
  });

  it("shows the host the server chose once its host is deleted, and sends nothing", () => {
    const opened = roomFormOf({ ...room, members: [hal, ana, bo], hostId: ana });
    const present = new Set([hal, bo]);
    const start = withoutDeleted(opened, present);
    const values = withoutDeleted(opened, present, start.hostPick);
    // The server moves the room to Hal, though Bo is the primary bot.
    const followed = followRoom(
      start,
      values,
      { ...room, members: [hal, bo], hostId: hal },
      hosted(bo),
    );
    expect(hostOf(followed.values, hosted(bo))).toBe(hal);
    expect(roomChanges(followed.start, followed.values, hosted(bo))).toEqual({
      _tag: "ready",
      value: {},
    });
  });

  it("sends the host it shows whenever the server's is another, as when that one leaves", () => {
    const opened = roomFormOf({ ...room, members: [hal, ana, bo], hostId: hal });
    // Another tab makes Ana the host; this form follows, then takes Ana out.
    const elsewhere: Room = { ...room, members: [hal, ana, bo], hostId: ana };
    const followed = followRoom(opened, opened, elsewhere, hosted());
    expect(hostOf(followed.values, hosted())).toBe(ana);
    const values = withMember(followed.values, ana, false);
    expect(hostOf(values, hosted())).toBe(hal);
    expect(roomChanges(followed.start, values, hosted())).toEqual({
      _tag: "ready",
      value: { members: [hal, bo], hostId: hal },
    });
  });

  it("gives a host picked and then deleted back to the server's", () => {
    const opened = roomFormOf({ ...room, members: [hal, ana, bo], hostId: hal });
    const values = { ...opened, hostPick: bo };
    const present = new Set([hal, ana]);
    const start = withoutDeleted(opened, present);
    expect(hostOf(withoutDeleted(values, present, start.hostPick), hosted(ana))).toBe(hal);
  });
});

describe("followRoom", () => {
  it("follows the room where the operator changed nothing, and keeps what they changed", () => {
    const opened = roomFormOf(room);
    const values = { ...opened, name: "Liftoff" };
    const elsewhere: Room = { ...room, name: "Launch v2", hopLimit: 6 };
    const followed = followRoom(opened, values, elsewhere, hosted());
    expect(followed.values).toEqual({ ...opened, name: "Liftoff", hopLimit: "6" });
    expect(roomChanges(followed.start, followed.values, hosted())).toEqual({
      _tag: "ready",
      value: { name: "Liftoff" },
    });
  });

  it("follows a field typed back to what it says, so Save does not undo a change made elsewhere", () => {
    const opened = roomFormOf(room);
    // The same hop limit and the same name, typed another way: nothing Save would send.
    const values = { ...opened, name: "Launch ", hopLimit: "04" };
    expect(roomChanges(opened, values, hosted())).toEqual({ _tag: "ready", value: {} });
    // Another tab renames the room and sets the hop limit to 6.
    const elsewhere: Room = { ...room, name: "Launch v2", hopLimit: 6 };
    const followed = followRoom(opened, values, elsewhere, hosted());
    expect(followed.values).toEqual({ ...opened, name: "Launch v2", hopLimit: "6" });
    expect(roomChanges(followed.start, followed.values, hosted())).toEqual({
      _tag: "ready",
      value: {},
    });
  });
});

describe("roomFormTarget", () => {
  it("stays while the form changes the same room the same way, and changes for anything else", () => {
    const edit = { _tag: "edit", room, gone: false } as const;
    const renamed = { ...edit, room: { ...room, name: "Liftoff" } };
    const unarchive = { _tag: "unarchive", room, gone: false } as const;
    const other = { ...edit, room: { ...room, id: RoomId.make("other") } };
    expect(roomFormTarget(renamed)).toBe(roomFormTarget(edit));
    const targets = [{ _tag: "create" } as const, edit, unarchive, other].map(roomFormTarget);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
