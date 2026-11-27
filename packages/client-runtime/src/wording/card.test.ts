// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotState,
  EntryId,
  type Room,
  RoomId,
  type Routine,
  RoutineId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, bot, context, plain } from "../../test/fixtures.ts";
import { cardLines } from "./card.ts";

const ctx = context("2026-11-27T15:00:00Z", "en", { ana: "Ana" });

const working = (littleOnes: number): BotState => ({
  _tag: "working",
  since: at("2026-11-27T14:56:00Z"),
  stalled: false,
  typing: false,
  retrying: false,
  activity: null,
  activityKind: "search",
  tool: null,
  littleOnes,
});

const room = (name: string, members: ReadonlyArray<string>, archived = false): Room => {
  const common = {
    id: RoomId.make(name.toLowerCase()),
    name,
    pinned: false,
    hidden: false,
    createdAt: at("2026-11-01T00:00:00Z"),
  };
  const ids = members.map((member) => bot(member).id);
  return archived
    ? { ...common, status: "archived", members: ids, archivedAt: at("2026-11-02T00:00:00Z") }
    : {
        ...common,
        status: "active",
        members: [ids[0] ?? bot("Ana").id, ids[1] ?? bot("Ana").id, ...ids.slice(2)],
        work: "none",
        forceStop: false,
        answering: [],
        memberWork: [],
      };
};

const routine = (name: string, enabled: boolean, nextRunAt: string | null): Routine => ({
  id: RoutineId.make(name),
  botId: bot("Lia").id,
  name,
  instruction: "Check the prices.",
  trigger: { _tag: "schedule", cron: "0 18 * * *", timeZone: "America/Sao_Paulo" },
  enabled,
  webhookUrl: null,
  nextRunAt: nextRunAt === null ? null : at(nextRunAt),
  lastRun: null,
  runCount: 0,
});

describe("cardLines", () => {
  it("puts each state in one of five, and words a usage limit with its reset", () => {
    const status = (state: BotState) => cardLines(bot("Lia", state), [], [], ctx);
    expect(status({ _tag: "idle" }).status).toBe("free");
    expect(status(working(0)).status).toBe("working");
    expect(status({ _tag: "waiting", entryId: EntryId.make("ask"), since: null }).status).toBe(
      "waiting",
    );
    const limit = status({
      _tag: "blocked",
      failure: "usage-limit",
      retryAt: at("2026-11-27T19:15:00Z"),
    });
    expect([limit.status, plain(limit.statusText)]).toEqual([
      "paused",
      "Usage limit reached, resets at 4:15 PM",
    ]);
    expect(status({ _tag: "blocked", failure: "unreachable", retryAt: null }).status).toBe("stuck");
  });

  it("says what a working bot does now, with its little ones, and nothing of a free one", () => {
    expect(plain(cardLines(bot("Lia", working(2)), [], [], ctx).now?.detail ?? "")).toBe(
      "2 little ones helping · started at 11:56 AM",
    );
    expect(plain(cardLines(bot("Lia", working(0)), [], [], ctx).now?.detail ?? "")).toBe(
      "Started at 11:56 AM",
    );
    expect(cardLines(bot("Lia"), [], [], ctx).now).toBeNull();
  });

  it("names who made the bot: the operator, its maker while it exists, or no one it knows", () => {
    const made = (madeBy: Parameters<typeof bot>[2]) =>
      cardLines(bot("Lia", { _tag: "idle" }, madeBy), [], [], ctx).made;
    const today = { createdAt: at("2026-11-27T12:00:00Z") };
    expect(made({ ...today, madeBy: { by: "operator", botId: null } })).toBe(
      "You created it today",
    );
    expect(made({ ...today, madeBy: { by: "bot", botId: bot("Ana").id } })).toBe(
      "Ana created it today, at your request",
    );
    expect(made({ ...today, madeBy: { by: "bot", botId: null } })).toBe(
      "A bot created it today, at your request",
    );
    expect(made({ createdAt: at("2026-11-02T12:00:00Z") })).toBe("Created on Nov 2");
  });

  it("counts its routines and names the next run of those that are on", () => {
    const routines = (list: ReadonlyArray<Routine> | null) =>
      cardLines(bot("Lia"), [], list, ctx).routines;
    expect(routines(null)).toBeNull();
    expect(routines([])).toBeNull();
    expect(
      plain(
        routines([
          routine("late", true, "2026-11-28T21:00:00Z"),
          routine("paused", false, "2026-11-27T16:00:00Z"),
          routine("soon", true, "2026-11-27T21:00:00Z"),
        ]) ?? "",
      ),
    ).toBe("3 routines · next at 6:00 PM");
    expect(routines([routine("paused", false, null)])).toBe("1 routine");
  });

  it("names the first three active rooms it is in and counts the rest", () => {
    const rooms = [
      room("Launch", ["Lia", "Ana"]),
      room("Prices", ["Ana", "Bia"]),
      room("Old", ["Lia", "Ana"], true),
      room("Menu", ["Lia", "Bia"]),
      room("Ads", ["Bia", "Lia"]),
    ];
    expect(cardLines(bot("Lia"), rooms.slice(0, 3), [], ctx).rooms?.text).toBe("In “Launch”");
    const four = [...rooms, room("Signs", ["Lia", "Ana"])];
    const line = cardLines(bot("Lia"), four, [], ctx).rooms;
    expect(line?.shown.map((shown) => shown.name)).toEqual(["Launch", "Menu", "Ads"]);
    expect(line?.text).toBe("In “Launch”, “Menu”, “Ads” and 1 more");
  });
});
