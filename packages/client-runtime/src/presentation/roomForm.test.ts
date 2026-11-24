// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId, type Room } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import {
  blankRoomForm,
  followRoom,
  hopLimitSteps,
  roomChanges,
  roomDraft,
  roomFormOf,
  roomFormStart,
  roomFormTarget,
  type RoomFormValues,
  sameRoomForm,
  withMember,
  withoutDeleted,
} from "./roomForm.ts";

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
  hopLimit: 4,
  pinned: false,
  createdAt: at("2026-11-01T00:00:00Z"),
  work: "none",
  answering: [],
};

/** The hop limit an empty field stands for. */
const DEFAULT_HOP_LIMIT = 4;

describe("withMember", () => {
  it("adds in the order picked, removes, and takes no seventh bot", () => {
    const six = form({ members: [hal, ana, bo, cy, di, ed] });
    expect(withMember(six, fy, true)).toBe(six);
    expect(withMember(six, ana, false).members).toEqual([hal, bo, cy, di, ed]);
    expect(withMember(form({ members: [ana] }), hal, true).members).toEqual([ana, hal]);
  });
});

describe("roomDraft", () => {
  it("needs a name and two to six bots", () => {
    const checked = roomDraft(form({ name: "  ", members: [hal] }));
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["name", "members"]);
  });

  it("leaves an empty hop limit to the server's default, and refuses one that is not a whole number", () => {
    expect(roomDraft(form({ name: " Launch ", members: [ana, hal] }))).toEqual({
      _tag: "ready",
      value: { name: "Launch", members: [ana, hal] },
    });
    const checked = roomDraft(form({ members: [ana, hal], hopLimit: "0" }));
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });
});

describe("roomChanges", () => {
  const opened = roomFormOf(room);

  it("sends only what changed from the form as it opened", () => {
    expect(roomChanges(opened, { ...opened, members: [ana, bo] }, DEFAULT_HOP_LIMIT)).toEqual({
      _tag: "ready",
      value: { members: [ana, bo] },
    });
    // Fields left as they opened are not sent, so a change made elsewhere meanwhile stands.
    expect(roomChanges(opened, { ...opened, hopLimit: "5" }, DEFAULT_HOP_LIMIT)).toEqual({
      _tag: "ready",
      value: { hopLimit: 5 },
    });
  });

  it("finds nothing to send for an edit the operator undid", () => {
    const undone = { ...opened, name: " Launch ", members: [hal, ana] };
    expect(sameRoomForm(opened, undone, DEFAULT_HOP_LIMIT)).toBe(true);
    expect(roomChanges(opened, undone, DEFAULT_HOP_LIMIT)).toEqual({ _tag: "ready", value: {} });
    expect(sameRoomForm(opened, { ...opened, members: [ana, hal] }, DEFAULT_HOP_LIMIT)).toBe(false);
  });

  it("sets an emptied hop limit back to the default, which must be known", () => {
    const values = { ...opened, hopLimit: "" };
    expect(roomChanges(opened, values, 6)).toEqual({ _tag: "ready", value: { hopLimit: 6 } });
    const checked = roomChanges(opened, values, null);
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });

  it("takes an archived room back once it has two to six bots again", () => {
    const archived: Room = {
      ...room,
      status: "archived",
      members: [hal],
      archivedAt: at("2026-11-02T00:00:00Z"),
    };
    const opened = roomFormOf(archived);
    const alone = roomChanges(opened, opened, DEFAULT_HOP_LIMIT);
    expect(alone._tag === "invalid" && [...alone.problems]).toEqual(["members"]);
    expect(roomChanges(opened, withMember(opened, scout, true), DEFAULT_HOP_LIMIT)).toEqual({
      _tag: "ready",
      value: { members: [hal, scout] },
    });
  });

  it("drops a bot deleted meanwhile, and sends nothing once the server drops it too", () => {
    const opened = roomFormOf({ ...room, members: [hal, ana, bo] });
    const present = new Set([hal, bo]);
    const start = withoutDeleted(opened, present);
    const values = withoutDeleted(opened, present);
    expect(values.members).toEqual([hal, bo]);
    const followed = followRoom(start, values, { ...room, members: [hal, bo] }, DEFAULT_HOP_LIMIT);
    expect(roomChanges(followed.start, followed.values, DEFAULT_HOP_LIMIT)).toEqual({
      _tag: "ready",
      value: {},
    });
  });
});

describe("followRoom", () => {
  it("follows the room where the operator changed nothing, and keeps what they changed", () => {
    const opened = roomFormOf(room);
    const values = { ...opened, name: "Liftoff" };
    const elsewhere: Room = { ...room, name: "Launch v2", hopLimit: 6 };
    const followed = followRoom(opened, values, elsewhere, DEFAULT_HOP_LIMIT);
    expect(followed.values).toEqual({ ...opened, name: "Liftoff", hopLimit: "6" });
    expect(roomChanges(followed.start, followed.values, DEFAULT_HOP_LIMIT)).toEqual({
      _tag: "ready",
      value: { name: "Liftoff" },
    });
  });

  it("keeps what is being typed when the server changes nothing the form shows", () => {
    const opened = roomFormOf(room);
    // Halfway through typing "Launch plan", and the hop limit cleared to the default.
    const values = { ...opened, name: "Launch ", hopLimit: "" };
    // A new message: the room is another object, its fields the same.
    const followed = followRoom(opened, values, { ...room }, DEFAULT_HOP_LIMIT);
    expect(followed.values).toEqual(values);
  });

  it("follows a field typed back to what it says, so Save does not undo a change made elsewhere", () => {
    const opened = roomFormOf(room);
    // The same hop limit and the same name, typed another way: nothing Save would send.
    const values = { ...opened, name: "Launch ", hopLimit: "04" };
    expect(roomChanges(opened, values, DEFAULT_HOP_LIMIT)).toEqual({ _tag: "ready", value: {} });
    // Another tab renames the room and sets the hop limit to 6.
    const elsewhere: Room = { ...room, name: "Launch v2", hopLimit: 6 };
    const followed = followRoom(opened, values, elsewhere, DEFAULT_HOP_LIMIT);
    expect(followed.values).toEqual({ ...opened, name: "Launch v2", hopLimit: "6" });
    expect(roomChanges(followed.start, followed.values, DEFAULT_HOP_LIMIT)).toEqual({
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

describe("hopLimitSteps", () => {
  it("steps from the number typed, never below one", () => {
    expect(hopLimitSteps("3", 4)).toEqual({ fewer: 2, more: 4 });
    expect(hopLimitSteps(" 1 ", 4)).toEqual({ fewer: null, more: 2 });
  });

  it("steps from the default while the field is empty", () => {
    expect(hopLimitSteps("", 4)).toEqual({ fewer: 3, more: 5 });
    expect(hopLimitSteps("", null)).toEqual({ fewer: null, more: null });
  });

  it("does not step from what is not a whole number from one up", () => {
    expect(hopLimitSteps("2.5", 4)).toEqual({ fewer: null, more: null });
    expect(hopLimitSteps("0", 4)).toEqual({ fewer: null, more: null });
  });
});

describe("roomFormStart", () => {
  it("starts a new room with the bots it was opened with, and a room the server has as it has it", () => {
    const start = roomFormStart({ _tag: "create", members: [ana, hal] });
    expect(start).toEqual({ ...blankRoomForm, members: [ana, hal] });
    expect(roomFormStart({ _tag: "create" })).toEqual(blankRoomForm);
    expect(roomFormStart({ _tag: "edit", room, gone: false })).toEqual(roomFormOf(room));
  });

  it("gives a new room opened with other bots another form", () => {
    expect(roomFormTarget({ _tag: "create", members: [ana, hal] })).not.toBe(
      roomFormTarget({ _tag: "create" }),
    );
  });
});
