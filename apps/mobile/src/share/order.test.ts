// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, ModelId, ProviderId, RoomId, type RosterItem } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { shareBots } from "./order.ts";

const bot = (
  name: string,
  given: { readonly pinned?: boolean; readonly hidden?: boolean; readonly active?: number } = {},
): RosterItem => ({
  _tag: "bot",
  bot: {
    id: BotId.make(name),
    profile: { name, title: "", avatar: { shape: "dome", color: "cobalt" }, job: "" },
    model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") },
    effort: null,
    fast: false,
    permissionMode: "auto",
    primary: false,
    pinned: given.pinned ?? false,
    hidden: given.hidden ?? false,
    sectionId: null,
    state: { _tag: "idle" },
    settingsHeld: false,
    forceStop: false,
    opening: false,
    browser: false,
    suggestedReply: null,
    createdAt: DateTime.makeUnsafe(0),
  },
  lastEntry: null,
  lastActivityAt: given.active === undefined ? null : DateTime.makeUnsafe(given.active),
  unread: false,
});

const room: RosterItem = {
  _tag: "room",
  room: {
    id: RoomId.make("lobby"),
    name: "Lobby",
    status: "active",
    members: [BotId.make("Ada"), BotId.make("Bo")],
    pinned: true,
    hidden: false,
    createdAt: DateTime.makeUnsafe(0),
    work: "none",
    forceStop: false,
    answering: [],
    memberWork: [],
  },
  lastEntry: null,
  lastActivityAt: DateTime.makeUnsafe(9),
  unread: false,
};

const names = (items: ReadonlyArray<{ readonly bot: { readonly id: string } }>) =>
  items.map((item) => item.bot.id);

describe("shareBots", () => {
  const roster = [
    bot("Recent", { active: 5 }),
    bot("Pinned", { pinned: true }),
    bot("Quiet"),
    bot("Hidden", { hidden: true, active: 8 }),
    room,
  ];

  it("offers pinned bots, then the rest in the roster's order, and no hidden bot or room", () => {
    expect(names(shareBots(roster, null))).toEqual(["Pinned", "Recent", "Quiet"]);
  });

  it("puts the bot last shared to first", () => {
    expect(names(shareBots(roster, "Quiet"))).toEqual(["Quiet", "Pinned", "Recent"]);
    // One no longer offered changes nothing.
    expect(names(shareBots(roster, "Hidden"))).toEqual(["Pinned", "Recent", "Quiet"]);
  });
});
