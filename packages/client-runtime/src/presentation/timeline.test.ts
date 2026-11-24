// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CommandId,
  EntryId,
  EntryOrder,
  type NoticeEntry,
  type RoutineChangeEntry,
  RoutineId,
} from "@j3-bots/contracts";
import type { OutgoingMessage } from "../stores/Conversations.ts";
import { describe, expect, it } from "vite-plus/test";
import { at, handoff, message } from "../../test/fixtures.ts";
import { arrivalCounts, arrivedRows, buildTimeline, readThrough, rowOrder } from "./timeline.ts";

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const wren = { _tag: "bot", botId: BotId.make("wren") } as const;
const shape = (items: ReturnType<typeof buildTimeline>) =>
  items.map((i) => (i.kind === "message" ? i.position : i.kind));

describe("readThrough", () => {
  it("reads through the highest order seen, wherever its row stands", () => {
    expect(readThrough([EntryOrder.make(3), null, EntryOrder.make(7), EntryOrder.make(5)])).toBe(7);
    expect(readThrough([null])).toBeNull();
  });
});

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

  it("does not join messages across a line", () => {
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
    expect(shape(items)).toEqual(["divider", "single", "event", "single"]);
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
    /** Each line: its key, then each routine it tells as "routine change name". */
    const lines = (items: ReturnType<typeof buildTimeline>) =>
      items.flatMap((i) =>
        i.kind === "event" && i.line._tag === "routines"
          ? [
              `${i.key}: ${i.line.changes
                .map((c) => `${c.routineId} ${c.change} ${c.name}`)
                .join(", ")}`,
            ]
          : [],
      );

    it("folds edits that follow a routine's creation or edit into its change, with the latest", () => {
      const items = buildTimeline([
        change("2026-11-20T10:00:00Z", "digest", "created"),
        change("2026-11-20T10:00:10Z", "digest", "updated"),
        change("2026-11-20T10:00:20Z", "digest", "updated"),
        change("2026-11-20T10:00:30Z", "backup", "updated"),
        change("2026-11-20T10:00:40Z", "backup", "updated"),
      ]);
      expect(lines(items)).toEqual([
        "change-1: digest created digest 3",
        "change-4: backup updated backup 5",
      ]);
    });

    it("joins changes of the same kind to other routines into one line", () => {
      const items = buildTimeline([
        change("2026-11-20T10:10:00Z", "digest", "created"),
        change("2026-11-20T10:10:10Z", "backup", "created"),
        change("2026-11-20T10:10:20Z", "backup", "updated"),
        change("2026-11-20T10:10:30Z", "bills", "created"),
        change("2026-11-20T10:10:40Z", "digest", "created"),
      ]);
      expect(lines(items)).toEqual([
        "change-6: digest created digest 6, backup created backup 8, bills created bills 9",
        "change-10: digest created digest 10",
      ]);
    });

    it("keeps a pause, a resume and a deletion of one routine on lines of their own", () => {
      const items = buildTimeline([
        change("2026-11-20T10:30:00Z", "digest", "created"),
        change("2026-11-20T10:30:10Z", "digest", "paused"),
        change("2026-11-20T10:30:20Z", "digest", "updated"),
        change("2026-11-20T10:30:30Z", "digest", "resumed"),
        change("2026-11-20T10:30:40Z", "digest", "deleted"),
      ]);
      expect(lines(items).map((line) => line.split(" ")[2])).toEqual([
        "created",
        "paused",
        "updated",
        "resumed",
        "deleted",
      ]);
    });

    it("keeps changes apart that a message, an author, another kind or a time separates", () => {
      const items = buildTimeline([
        change("2026-11-20T11:00:00Z", "digest", "created"),
        change("2026-11-20T11:00:05Z", "backup", "paused"),
        message("2026-11-20T11:00:15Z", scout),
        change("2026-11-20T11:00:20Z", "digest", "updated"),
        change("2026-11-20T11:00:30Z", "backup", "updated", { _tag: "operator" }),
        change("2026-11-20T11:30:00Z", "bills", "updated", { _tag: "operator" }),
      ]);
      expect(lines(items).map((line) => line.split(" ").slice(1, 3).join(" "))).toEqual([
        "digest created",
        "backup paused",
        "digest updated",
        "backup updated",
        "bills updated",
      ]);
    });

    it("lets the operator read through a folded line's latest change", () => {
      const created = change("2026-11-20T12:00:10Z", "digest", "created");
      const edited = change("2026-11-20T12:00:20Z", "digest", "updated");
      const items = buildTimeline([created, edited]);
      expect(items.map(rowOrder)).toEqual([null, edited.order]);
      expect(readThrough(items.map(rowOrder))).toBe(edited.order);
    });
  });

  describe("teammate messages", () => {
    /** The runs of teammate messages among `items`, each as how many messages it tells. */
    const runs = (items: ReturnType<typeof buildTimeline>) =>
      items.map((i) =>
        i.kind === "event" && i.line._tag === "teammates"
          ? `teammates×${i.line.run.entries.length}`
          : i.kind,
      );

    it("tells consecutive messages in one line, which anything between them ends", () => {
      const items = buildTimeline([
        message("2026-11-20T10:00:00Z"),
        handoff("2026-11-20T10:01:00Z", "scout", "wren", "sent"),
        handoff("2026-11-20T10:02:00Z", "scout", "wren", "received"),
        message("2026-11-20T10:03:00Z", scout),
        handoff("2026-11-20T10:04:00Z", "scout", "wren", "sent"),
      ]);
      expect(runs(items)).toEqual(["divider", "message", "teammates×2", "message", "teammates×1"]);
    });

    it("keeps one line across a time, under the first message's key", () => {
      const first = handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent");
      const items = buildTimeline([
        first,
        handoff("2026-11-20T13:00:00Z", "scout", "wren", "received"),
        message("2026-11-20T18:00:00Z"),
      ]);
      expect(runs(items)).toEqual(["divider", "teammates×2", "divider", "message"]);
      expect(items[1]?.key).toBe(first.id);
    });

    it("lists each teammate once, in the order met, with where its conversation opens", () => {
      const toWren = handoff("2026-11-20T10:00:00Z", "scout", "wren", "sent");
      const fromPip = handoff("2026-11-20T10:01:00Z", "scout", "pip", "received", "not-delivered");
      const last = handoff("2026-11-20T10:02:00Z", "scout", "wren", "received", "stopped");
      const row = buildTimeline([toWren, fromPip, last]).find((i) => i.kind === "event");
      if (row?.kind !== "event" || row.line._tag !== "teammates")
        return expect.fail("The messages were not told in one line");
      expect(row.line.run).toMatchObject({ direction: "both", undelivered: 2 });
      expect(row.line.run.pairs).toEqual([
        { peer: "wren", botIds: ["scout", "wren"], first: toWren.id, count: 2 },
        { peer: "pip", botIds: ["pip", "scout"], first: fromPip.id, count: 1 },
      ]);
      // The line is read through its newest message.
      expect(rowOrder(row)).toBe(last.order);
    });
  });

  it("tells a saved name and a routine J3 Bots paused in lines, and keeps other notices cards", () => {
    const notice = (n: number, value: NoticeEntry["notice"]): NoticeEntry => ({
      _tag: "notice",
      id: EntryId.make(`notice-${n}`),
      order: EntryOrder.make(200 + n),
      author: { _tag: "system" },
      createdAt: at(`2026-11-20T12:00:0${n}Z`),
      notice: value,
      retryable: false,
    });
    const items = buildTimeline([
      notice(1, { _tag: "operator-named", botId: scout.botId, name: "Jo" }),
      notice(2, { _tag: "routine-paused", routineId: RoutineId.make("digest"), name: "Digest" }),
      notice(3, { _tag: "session-lost" }),
    ]);
    expect(
      items.map((i) =>
        i.kind === "event" ? i.line._tag : i.kind === "card" ? i.entry._tag : i.kind,
      ),
    ).toEqual(["divider", "operator-named", "routine-paused", "notice"]);
  });
});

describe("arrivedRows", () => {
  it("finds nothing on a conversation's first render", () => {
    expect(arrivedRows(null, ["a", "b"])).toEqual(new Set());
  });

  it("finds the rows added after the newest one shown before", () => {
    expect(arrivedRows(["a", "b"], ["a", "b", "divider-c", "c"])).toEqual(
      new Set(["divider-c", "c"]),
    );
  });

  it("counts the first rows of an empty conversation as arrived", () => {
    expect(arrivedRows([], ["a"])).toEqual(new Set(["a"]));
  });

  it("does not count earlier rows loaded above", () => {
    expect(arrivedRows(["c", "d"], ["a", "b", "c", "d"])).toEqual(new Set());
  });

  it("does not count a row that kept its key as it changed", () => {
    expect(arrivedRows(["a", "b"], ["a", "b"])).toEqual(new Set());
  });

  it("finds rows after the newest kept row when the newest shown one went", () => {
    expect(arrivedRows(["a", "b"], ["a", "c"])).toEqual(new Set(["c"]));
  });

  it("finds nothing when none of the rows shown before are left", () => {
    expect(arrivedRows(["a"], ["x", "y"])).toEqual(new Set());
  });
});

describe("arrivalCounts", () => {
  const outgoing: OutgoingMessage = {
    _tag: "outgoing",
    commandId: CommandId.make("sent-here"),
    target: { _tag: "conversation", botId: BotId.make("scout") },
    text: "On my way",
    attachments: [],
    mentions: null,
    labels: [],
    createdAt: at("2026-11-20T10:05:00Z"),
    status: { _tag: "sending" },
  };
  const rows = buildTimeline([
    message("2026-11-20T10:00:00Z", scout),
    message("2026-11-20T10:30:00Z", scout),
    message("2026-11-20T10:31:00Z", wren),
    message("2026-11-20T10:32:00Z"),
  ]);

  it("counts only what arrived, and only messages others wrote", () => {
    // Everything after the first message: a time, both bots' messages, and one the operator
    // wrote on another device.
    const [, first, ...later] = rows;
    expect(first?.kind).toBe("message");
    expect(arrivalCounts(rows, new Set(later.map((row) => row.key)))).toEqual({
      own: false,
      others: 2,
    });
  });

  it("tells a message sent from this device apart from others'", () => {
    const withOwn = buildTimeline([message("2026-11-20T10:00:00Z", scout), outgoing]);
    const own = new Set(withOwn.filter((row) => row.kind === "message").map((row) => row.key));
    expect(arrivalCounts(withOwn, own)).toEqual({ own: true, others: 1 });
  });
});
