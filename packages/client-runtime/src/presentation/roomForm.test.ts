// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId, type Room } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import {
  blankRoomForm,
  followRoom,
  roomChanges,
  roomDraft,
  roomFormOf,
  roomFormStart,
  roomFormTarget,
  type RoomFormValues,
  sameRoomForm,
  startAfterChange,
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
  pinned: false,
  hidden: false,
  createdAt: at("2026-11-01T00:00:00Z"),
  work: "none",
  answering: [],
  memberWork: [],
};

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

  it("sends the name without the spaces around it and the bots in the order picked", () => {
    expect(roomDraft(form({ name: " Launch ", members: [ana, hal] }))).toEqual({
      _tag: "ready",
      value: { name: "Launch", members: [ana, hal] },
    });
  });

  it("asks for a hidden room only when the operator chose one", () => {
    const hidden = roomDraft(form({ members: [ana, hal], hidden: true }));
    expect(hidden._tag === "ready" && hidden.value.hidden).toBe(true);
  });
});

describe("roomChanges", () => {
  const opened = roomFormOf(room);

  it("sends only what changed from the form as it opened", () => {
    // Fields left as they opened are not sent, so a change made elsewhere meanwhile stands.
    expect(roomChanges(opened, { ...opened, members: [ana, bo] })).toEqual({
      _tag: "ready",
      value: { members: [ana, bo] },
    });
  });

  it("sends whether the room is hidden only when the operator changed it", () => {
    expect(roomChanges(opened, { ...opened, hidden: true })).toEqual({
      _tag: "ready",
      value: { hidden: true },
    });
    expect(sameRoomForm(opened, { ...opened, hidden: true })).toBe(false);
  });

  it("finds nothing to send for an edit the operator undid", () => {
    const undone = { ...opened, name: " Launch ", members: [hal, ana] };
    expect(sameRoomForm(opened, undone)).toBe(true);
    expect(roomChanges(opened, undone)).toEqual({ _tag: "ready", value: {} });
    expect(sameRoomForm(opened, { ...opened, members: [ana, hal] })).toBe(false);
  });

  it("takes an archived room back once it has two to six bots again", () => {
    const archived: Room = {
      ...room,
      status: "archived",
      members: [hal],
      archivedAt: at("2026-11-02T00:00:00Z"),
    };
    const opened = roomFormOf(archived);
    const alone = roomChanges(opened, opened);
    expect(alone._tag === "invalid" && [...alone.problems]).toEqual(["members"]);
    expect(roomChanges(opened, withMember(opened, scout, true))).toEqual({
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
    const followed = followRoom(start, values, { ...room, members: [hal, bo] });
    expect(roomChanges(followed.start, followed.values)).toEqual({ _tag: "ready", value: {} });
  });
});

describe("followRoom", () => {
  it("follows the room where the operator changed nothing, and keeps what they changed", () => {
    const opened = roomFormOf(room);
    const values = { ...opened, name: "Liftoff" };
    const elsewhere: Room = { ...room, name: "Launch v2", members: [hal, ana, bo] };
    const followed = followRoom(opened, values, elsewhere);
    expect(followed.values).toEqual({ name: "Liftoff", members: [hal, ana, bo], hidden: false });
    expect(roomChanges(followed.start, followed.values)).toEqual({
      _tag: "ready",
      value: { name: "Liftoff" },
    });
  });

  it("sends the operator's hidden switch even when a bot set the room the same meanwhile", () => {
    const opened = roomFormOf(room);
    const on = { ...opened, hidden: true };
    const hiddenRoom: Room = { ...room, hidden: true };
    const followed = followRoom(startAfterChange(opened, opened, on, room), on, hiddenRoom);
    expect(roomChanges(followed.start, followed.values)).toEqual({
      _tag: "ready",
      value: { hidden: true },
    });
    // Moved back off with the room hidden now: that is a choice to show it.
    const off = { ...on, hidden: false };
    const start = startAfterChange(followed.start, on, off, hiddenRoom);
    expect(roomChanges(start, off)).toEqual({ _tag: "ready", value: { hidden: false } });
    // Moved back to what the room is: nothing to send.
    expect(sameRoomForm(startAfterChange(opened, on, opened, room), opened)).toBe(true);
  });

  it("follows the room shown again elsewhere, so Save does not hide it back", () => {
    const hiddenRoom: Room = { ...room, hidden: true };
    const opened = roomFormOf(hiddenRoom);
    const values = { ...opened, name: "Liftoff" };
    const followed = followRoom(opened, values, room);
    expect(roomChanges(followed.start, followed.values)).toEqual({
      _tag: "ready",
      value: { name: "Liftoff" },
    });
  });

  it("keeps what is being typed when the server changes nothing the form shows", () => {
    const opened = roomFormOf(room);
    // Halfway through typing "Launch plan".
    const values = { ...opened, name: "Launch " };
    // A new message: the room is another object, its fields the same.
    const followed = followRoom(opened, values, { ...room });
    expect(followed.values).toEqual(values);
  });

  it("follows a field typed back to what it says, so Save does not undo a change made elsewhere", () => {
    const opened = roomFormOf(room);
    // The same name, typed with a space after it: nothing Save would send.
    const values = { ...opened, name: "Launch " };
    expect(roomChanges(opened, values)).toEqual({ _tag: "ready", value: {} });
    // Another tab renames the room.
    const elsewhere: Room = { ...room, name: "Launch v2" };
    const followed = followRoom(opened, values, elsewhere);
    expect(followed.values).toEqual({ ...opened, name: "Launch v2" });
    expect(roomChanges(followed.start, followed.values)).toEqual({ _tag: "ready", value: {} });
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
