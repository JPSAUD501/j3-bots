// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId, type Room } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../test/fixtures";
import {
  blankRoomForm,
  hostOf,
  roomChanges,
  roomDraft,
  roomFormOf,
  type RoomFormValues,
  withMember,
} from "./roomForm";

const hal = BotId.make("hal");
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

describe("hostOf", () => {
  it("keeps the host picked while it is a member, else the primary bot, else the first member", () => {
    expect(hostOf(form({ members: [ana, hal], hostPick: hal }), bo)).toBe(hal);
    expect(hostOf(form({ members: [ana, hal], hostPick: bo }), hal)).toBe(hal);
    expect(hostOf(form({ members: [ana, hal], hostPick: null }), bo)).toBe(ana);
    expect(hostOf(form({ members: [] }), hal)).toBeNull();
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
  it("needs a name and two to six bots", () => {
    const checked = roomDraft(form({ name: "  ", members: [hal] }), null);
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["name", "members"]);
  });

  it("leaves an empty hop limit to the server's default, and refuses one that is not a whole number", () => {
    expect(roomDraft(form({ name: " Launch ", members: [ana, hal] }), hal)).toEqual({
      _tag: "ready",
      value: { name: "Launch", members: [ana, hal], hostId: hal },
    });
    const checked = roomDraft(form({ members: [ana, hal], hopLimit: "0" }), null);
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });
});

describe("roomChanges", () => {
  it("sends only what changed, and a host that follows when its bot leaves", () => {
    const values = { ...roomFormOf(room), members: [ana, bo] };
    expect(roomChanges(room, values, null, 4)).toEqual({
      _tag: "ready",
      value: { members: [ana, bo], hostId: ana },
    });
    expect(roomChanges(room, roomFormOf(room), null, 4)).toEqual({ _tag: "ready", value: {} });
  });

  it("sets an emptied hop limit back to the default, which must be known", () => {
    const values = { ...roomFormOf(room), hopLimit: "" };
    expect(roomChanges(room, values, null, 6)).toEqual({ _tag: "ready", value: { hopLimit: 6 } });
    const checked = roomChanges(room, values, null, null);
    expect(checked._tag === "invalid" && [...checked.problems]).toEqual(["hop-limit"]);
  });
});
