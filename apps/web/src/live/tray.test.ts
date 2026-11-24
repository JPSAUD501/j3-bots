// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Bot, DeviceId, EntryId, RoomId, type RosterItem } from "@j3-bots/contracts";
import { TRAY_LISTED } from "@j3-bots/desktop-bridge";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "@j3-bots/client-runtime/testing";
import { trayReport } from "./tray";

const pairing = DeviceId.make("device-1");

const row = (b: Bot, minutesAgo: number, unread = false): RosterItem => ({
  _tag: "bot",
  bot: b,
  lastEntry: null,
  lastActivityAt: at(`2026-11-20T14:${String(59 - minutesAgo).padStart(2, "0")}:00Z`),
  unread,
});

const room = (name: string, unread: boolean): RosterItem => ({
  _tag: "room",
  room: {
    id: RoomId.make(name.toLowerCase()),
    name,
    status: "active",
    members: [bot("Scout").id, bot("Wren").id],
    pinned: false,
    createdAt: at("2026-11-01T00:00:00Z"),
    work: "none",
    answering: [],
  },
  lastEntry: null,
  lastActivityAt: at("2026-11-20T14:00:00Z"),
  unread,
});

const asking = (name: string, extra: Partial<Bot> = {}) =>
  bot(name, { _tag: "waiting", entryId: EntryId.make(`card-${name}`), since: null }, extra);

describe("the tray", () => {
  it("lists the bots and rooms that need the operator, in roster order", () => {
    const report = trayReport(
      [
        row(bot("Idle"), 0),
        row(bot("Reader"), 5, true),
        row(asking("Asker"), 30),
        room("Launch", true),
        row(bot("Pinned", { _tag: "idle" }, { pinned: true }), 50, true),
        // Hidden from the roster, so from the tray too, though it asks.
        row(asking("Hidden", { hidden: true }), 1),
      ],
      pairing,
    );
    expect(report.pairing).toBe(pairing);
    expect(report.count).toBe(4);
    expect(report.waiting.map((waiting) => waiting.name)).toEqual([
      "Pinned",
      "Reader",
      "Asker",
      "Launch",
    ]);
    expect(report.waiting[3]?.target).toEqual({ _tag: "room", roomId: RoomId.make("launch") });
    expect(report.waiting[2]?.target).toEqual({ _tag: "conversation", botId: asking("Asker").id });
  });

  it("names the first ones and counts them all", () => {
    const many = Array.from({ length: TRAY_LISTED + 3 }, (_, i) =>
      row(bot(`Bot ${String(i).padStart(2, "0")}`), i, true),
    );
    const report = trayReport(many, pairing);
    expect(report.count).toBe(TRAY_LISTED + 3);
    expect(report.waiting).toHaveLength(TRAY_LISTED);
    expect(report.waiting[0]?.name).toBe("Bot 00");
  });

  it("lists nothing before the roster loads or without a pairing", () => {
    const empty = { pairing: null, count: 0, waiting: [] };
    expect(trayReport(null, pairing)).toEqual(empty);
    expect(trayReport([row(asking("Asker"), 1)], null)).toEqual(empty);
  });
});
