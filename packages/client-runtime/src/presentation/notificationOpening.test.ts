// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, type PushData, RoomId, type RosterItem } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot } from "../../test/fixtures.ts";
import type { Synced } from "../stores/synced.ts";
import { pushOpening } from "./notificationOpening.ts";

const phone = DeviceId.make("device-phone");
const pairedAgain = DeviceId.make("device-phone-again");

const scout = bot("Scout");
const archivist = bot("Archivist", { _tag: "idle" }, { hidden: true });
const launch = RoomId.make("launch");

const botRow = (listed: typeof scout): RosterItem => ({
  _tag: "bot",
  bot: listed,
  lastEntry: null,
  lastActivityAt: null,
  unread: true,
});
const roster: Synced<ReadonlyArray<RosterItem>> = {
  _tag: "ready",
  stale: false,
  value: [
    botRow(scout),
    botRow(archivist),
    {
      _tag: "room",
      room: {
        id: launch,
        name: "Launch",
        status: "active",
        members: [scout.id, archivist.id],
        pinned: false,
        hidden: false,
        createdAt: at("2026-11-01T00:00:00Z"),
        work: "none",
        answering: [],
        memberWork: [],
      },
      lastEntry: null,
      lastActivityAt: null,
      unread: true,
    },
  ],
};
const loading: Synced<ReadonlyArray<RosterItem>> = { _tag: "loading" };

/** A push's data as the push service hands it to the app: parsed from JSON. */
const received = (data: unknown): unknown => JSON.parse(JSON.stringify(data));
const about = (target: PushData["target"], deviceId: string = phone) =>
  received({ deviceId, target, entryId: "entry-1" });

describe("pushOpening", () => {
  it("opens the conversation or room the push is about, a hidden bot's included", () => {
    expect(pushOpening(about({ _tag: "conversation", botId: scout.id }), phone, roster)).toEqual({
      _tag: "open",
      target: { _tag: "conversation", botId: scout.id },
    });
    expect(pushOpening(about({ _tag: "room", roomId: launch }), phone, roster)).toEqual({
      _tag: "open",
      target: { _tag: "room", roomId: launch },
    });
    expect(
      pushOpening(about({ _tag: "conversation", botId: archivist.id }), phone, roster)._tag,
    ).toBe("open");
  });

  it("drops a push sent to a pairing this device no longer follows", () => {
    const toScout = about({ _tag: "conversation", botId: scout.id });
    expect(pushOpening(toScout, pairedAgain, roster)).toEqual({ _tag: "drop" });
    expect(pushOpening(toScout, null, roster)).toEqual({ _tag: "drop" });
    // Whatever the roster: it is not this pairing's to open.
    expect(pushOpening(toScout, pairedAgain, loading)).toEqual({ _tag: "drop" });
  });

  it("drops a push about a bot or room the roster no longer lists", () => {
    const gone = bot("Gone");
    expect(pushOpening(about({ _tag: "conversation", botId: gone.id }), phone, roster)).toEqual({
      _tag: "drop",
    });
    expect(
      pushOpening(about({ _tag: "room", roomId: RoomId.make("archive") }), phone, roster),
    ).toEqual({ _tag: "drop" });
  });

  it("waits for the roster when the tap comes before it loaded", () => {
    const toScout = about({ _tag: "conversation", botId: scout.id });
    expect(pushOpening(toScout, phone, loading)).toEqual({ _tag: "wait" });
    expect(pushOpening(toScout, phone, roster)._tag).toBe("open");
  });

  it("drops data it cannot read", () => {
    for (const data of [
      null,
      "entry-1",
      received({ target: { _tag: "conversation", botId: scout.id }, entryId: "entry-1" }),
      received({ deviceId: phone, target: { _tag: "thread", id: "t1" }, entryId: "entry-1" }),
      received({ deviceId: phone, target: { _tag: "room" }, entryId: "entry-1" }),
    ]) {
      expect(pushOpening(data, phone, roster)).toEqual({ _tag: "drop" });
    }
  });
});
