// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CommandId,
  EntryId,
  EntryOrder,
  type RoutineChangeEntry,
  RoutineId,
} from "@j3-bots/contracts";
import type { OutgoingMessage } from "../stores/Conversations.ts";
import { describe, expect, it } from "vite-plus/test";
import { at, message } from "../../test/fixtures.ts";
import { buildTimeline } from "./timeline.ts";

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const wren = { _tag: "bot", botId: BotId.make("wren") } as const;
const shape = (items: ReturnType<typeof buildTimeline>) =>
  items.map((i) => (i.kind === "message" ? i.position : i.kind));

describe("buildTimeline", () => {
  it("groups one author's messages that follow closely", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z", scout),
      message("2026-11-20T10:01:00Z", scout),
      message("2026-11-20T10:02:00Z", scout),
      message("2026-11-20T10:03:00Z", wren),
      message("2026-11-20T10:04:00Z"),
    ]);
    expect(shape(items)).toEqual(["divider", "first", "middle", "last", "single", "single"]);
  });

  it("breaks a group after a pause and puts the time between long ones", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z"),
      message("2026-11-20T10:06:00Z"),
      message("2026-11-20T10:30:00Z"),
    ]);
    expect(shape(items)).toEqual(["divider", "single", "single", "divider", "single"]);
    expect(items[3]?.kind === "divider" && items[3].at).toEqual(at("2026-11-20T10:30:00Z"));
  });

  it("does not join messages across a card", () => {
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z", scout),
      {
        _tag: "handoff",
        id: EntryId.make("handoff"),
        order: EntryOrder.make(1),
        author: scout,
        createdAt: at("2026-11-20T10:00:30Z"),
        recipientId: BotId.make("wren"),
        direction: "sent",
        text: "Over to you",
        urgent: false,
        state: "sent",
      },
      message("2026-11-20T10:01:00Z", scout),
    ]);
    expect(shape(items)).toEqual(["divider", "single", "card", "single"]);
  });

  it("keeps an entry, and a notice, of a kind added after this build as a line in its place", () => {
    const placed = (n: number, iso: string) => ({
      id: EntryId.make(`later-${n}`),
      order: EntryOrder.make(100 + n),
      createdAt: at(iso),
    });
    const items = buildTimeline([
      message("2026-11-20T10:00:00Z", scout),
      { _tag: "unknown", kind: "poll", ...placed(1, "2026-11-20T10:00:10Z") },
      {
        _tag: "notice",
        ...placed(2, "2026-11-20T10:00:20Z"),
        author: { _tag: "system" },
        notice: { _tag: "unknown", kind: "budget-reached" },
        retryable: true,
      },
      message("2026-11-20T10:00:30Z", scout),
    ]);
    expect(shape(items)).toEqual(["divider", "single", "unknown", "unknown", "single"]);
    expect(items.filter((item) => item.kind === "unknown")).toEqual([
      { kind: "unknown", key: "later-1", id: "later-1", order: 101 },
      { kind: "unknown", key: "later-2", id: "later-2", order: 102 },
    ]);
  });

  it("joins a message on its way to the operator's group, and keeps its key once it arrives", () => {
    const commandId = CommandId.make("cmd_hello");
    const outgoing: OutgoingMessage = {
      _tag: "outgoing",
      commandId,
      target: { _tag: "conversation", botId: BotId.make("scout") },
      text: "hello",
      attachments: [],
      mentions: null,
      labels: [],
      createdAt: at("2026-11-20T10:01:00Z"),
      status: { _tag: "sending" },
    };
    const sending = buildTimeline([message("2026-11-20T10:00:00Z"), outgoing]);
    expect(shape(sending)).toEqual(["divider", "first", "last"]);
    const arrived = buildTimeline([
      message("2026-11-20T10:00:00Z"),
      message("2026-11-20T10:01:00Z", { _tag: "operator" }, "hello", { commandId }),
    ]);
    expect(arrived.at(-1)?.key).toBe(sending.at(-1)?.key);
  });

  describe("routine changes", () => {
    let order = 0;
    const change = (
      iso: string,
      routine: string,
      kind: RoutineChangeEntry["change"],
      author: RoutineChangeEntry["author"] = scout,
    ): RoutineChangeEntry => {
      order += 1;
      return {
        _tag: "routine-change",
        id: EntryId.make(`change-${order}`),
        order: EntryOrder.make(order),
        author,
        createdAt: at(iso),
        routineId: RoutineId.make(routine),
        name: `${routine} ${order}`,
        change: kind,
        trigger: { _tag: "webhook" },
      };
    };
    const cards = (items: ReturnType<typeof buildTimeline>) =>
      items.flatMap((i) =>
        i.kind === "card" && i.entry._tag === "routine-change"
          ? [`${i.key} ${i.entry.routineId} ${i.entry.change} ${i.entry.name}`]
          : [],
      );

    it("folds a run of changes to one routine into one card that shows the latest", () => {
      const items = buildTimeline([
        change("2026-11-20T10:00:00Z", "digest", "created"),
        change("2026-11-20T10:00:10Z", "backup", "created"),
        change("2026-11-20T10:00:20Z", "digest", "updated"),
        change("2026-11-20T10:00:30Z", "digest", "updated"),
        change("2026-11-20T10:00:40Z", "backup", "paused"),
      ]);
      expect(cards(items)).toEqual([
        "change-1 digest created digest 4",
        "change-2 backup paused backup 5",
      ]);
    });

    it("keeps changes apart that something else, an author or a pause separates", () => {
      const items = buildTimeline([
        change("2026-11-20T11:00:00Z", "digest", "updated"),
        message("2026-11-20T11:00:05Z", scout),
        change("2026-11-20T11:00:10Z", "digest", "updated"),
        change("2026-11-20T11:00:20Z", "digest", "paused", { _tag: "operator" }),
        change("2026-11-20T11:30:00Z", "digest", "resumed", { _tag: "operator" }),
      ]);
      expect(cards(items).map((card) => card.split(" ")[2])).toEqual([
        "updated",
        "updated",
        "paused",
        "resumed",
      ]);
    });
  });
});
