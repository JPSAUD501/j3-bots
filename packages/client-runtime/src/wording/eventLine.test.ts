// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  EntryOrder,
  type HandoffEntry,
  type NoticeEntry,
  RoomId,
  type RoutineChangeEntry,
  RoutineId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, handoff } from "../../test/fixtures.ts";
import { type EventLine, eventLineOpens, type LineSetting } from "../presentation/eventLine.ts";
import { buildTimeline } from "../presentation/timeline.ts";
import { eventLineWords, type EventRun, handoffMarks } from "./eventLine.ts";

const scout = BotId.make("scout");
const wren = BotId.make("wren");
const pip = BotId.make("pip");
const names = { scout: "Scout", wren: "Wren", pip: "Pip" };
const support = RoomId.make("support");
const rooms = { support: "Support" };
const en = context("2026-11-20T12:00:00Z", "en", names, rooms);
const pt = context("2026-11-20T12:00:00Z", "pt-BR", names, rooms);

/** Where a line is read: Scout's conversation, or the Support room, with the rooms `en` knows. */
const inConversation: LineSetting = { room: null, roomName: en.roomName };
const inSupport: LineSetting = { room: support, roomName: en.roomName };

/** The line teammate messages make together in Scout's conversation, as the timeline tells them. */
const teammates = (...cards: ReadonlyArray<HandoffEntry>): EventLine => {
  const row = buildTimeline(cards).find((item) => item.kind === "event");
  if (row?.kind !== "event") throw new Error("The messages were not told in a line");
  return row.line;
};
const sent = (peer = "wren", state?: HandoffEntry["state"]) =>
  handoff("2026-11-20T11:00:00Z", "scout", peer, "sent", state);
const received = (peer = "wren", state?: HandoffEntry["state"]) =>
  handoff("2026-11-20T11:01:00Z", "scout", peer, "received", state);
const routineChange = (
  change: RoutineChangeEntry["change"],
  routine = "digest",
  name = "Morning digest",
): RoutineChangeEntry => ({
  _tag: "routine-change",
  id: EntryId.make(`r-${routine}-${change}`),
  order: EntryOrder.make(1),
  author: { _tag: "bot", botId: scout },
  createdAt: at("2026-11-20T11:00:00Z"),
  routineId: RoutineId.make(routine),
  name,
  change,
  trigger: { _tag: "webhook" },
});
const routine = (change: RoutineChangeEntry["change"]): EventLine => ({
  _tag: "routines",
  changes: [routineChange(change)],
});

/** A team notice by Scout about the Support room, as the timeline tells it. */
const teamLine = (tag: "room-started" | "made-for-room", by = scout): EventLine => {
  const entry: NoticeEntry = {
    _tag: "notice",
    id: EntryId.make(`n-${tag}`),
    order: EntryOrder.make(1),
    author: { _tag: "bot", botId: by },
    createdAt: at("2026-11-20T11:00:00Z"),
    notice: { _tag: tag, botId: by, roomId: support },
    retryable: false,
  };
  const row = buildTimeline([entry]).find((item) => item.kind === "event");
  if (row?.kind !== "event") throw new Error("The notice was not told in a line");
  return row.line;
};

/** The runs with the strong ones marked, to read a line's emphasis at a glance. */
const marked = (runs: ReadonlyArray<EventRun>) =>
  runs.map((run) => (run.strong ? `*${run.text}*` : run.text)).join("");

describe("eventLineWords", () => {
  it("says what the bot did with its teammates, each name strong, led by the first one's face", () => {
    const wrote = eventLineWords(teammates(sent()), en);
    expect(marked(wrote.runs)).toBe("Wrote to *Wren*");
    expect(wrote.lead).toEqual({ _tag: "bot", botId: wren });
    expect(marked(eventLineWords(teammates(received()), pt).runs)).toBe("*Wren* escreveu");
    expect(marked(eventLineWords(teammates(sent(), received(), sent("pip")), en).runs)).toBe(
      "Talked with *Wren* and *Pip* · 3 messages",
    );
  });

  it("agrees the verb with several teammates in Portuguese", () => {
    expect(marked(eventLineWords(teammates(received(), received("pip")), pt).runs)).toBe(
      "*Wren* e *Pip* escreveram · 2 mensagens",
    );
  });

  it("counts the messages that never reached their teammate, and reads the count with the line", () => {
    const line = teammates(sent("wren", "not-delivered"), sent("wren", "stopped"));
    const words = eventLineWords(line, en);
    expect(words.status).toEqual({ text: "2 not delivered", tone: "blocked" });
    expect(words.label).toBe("Wrote to Wren · 2 messages, 2 not delivered");
    expect(eventLineWords(line, pt).status?.text).toBe("2 não entregues");
  });

  it("names a deleted teammate as such, with a glyph for its face", () => {
    const nobody = context("2026-11-20T12:00:00Z", "en");
    const words = eventLineWords(teammates(sent()), nobody);
    expect(words.label).toBe("Wrote to a deleted bot");
    expect(words.lead).toEqual({ _tag: "icon", icon: "message" });
    expect(eventLineWords(teammates(received()), nobody).label).toBe("A deleted bot wrote");
  });

  it("tells a routine's change with its name strong, and a glyph for the change", () => {
    expect(marked(eventLineWords(routine("created"), en).runs)).toBe(
      "Routine *Morning digest* created",
    );
    expect(eventLineWords(routine("created"), en).lead).toEqual({ _tag: "icon", icon: "webhook" });
    expect(eventLineWords(routine("deleted"), pt)).toMatchObject({
      label: "Rotina Morning digest excluída",
      lead: { _tag: "icon", icon: "deleted" },
    });
  });

  it("counts routines changed alike, and names none of them", () => {
    const words = eventLineWords(
      {
        _tag: "routines",
        changes: [
          routineChange("created"),
          routineChange("created", "bills", "Bills"),
          routineChange("created", "backup", "Backup"),
        ],
      },
      pt,
    );
    expect(marked(words.runs)).toBe("3 rotinas criadas");
    expect(words.lead).toEqual({ _tag: "icon", icon: "routine" });
  });

  it("names the bot that saved the operator's name, and the name", () => {
    const words = eventLineWords(
      {
        _tag: "operator-named",
        entry: {
          _tag: "notice",
          id: EntryId.make("n1"),
          order: EntryOrder.make(1),
          author: { _tag: "system" },
          createdAt: at("2026-11-20T11:00:00Z"),
          notice: { _tag: "operator-named", botId: scout, name: "Jo" },
          retryable: false,
        },
      },
      pt,
    );
    expect(marked(words.runs)).toBe("*Scout* salvou seu nome: *Jo*");
    expect(words.lead).toEqual({ _tag: "bot", botId: scout });
  });
});

describe("eventLineWords, team lines", () => {
  it("names the bot and the room as they are now, led by the bot's face", () => {
    const started = eventLineWords(teamLine("room-started"), en);
    expect(marked(started.runs)).toBe("*Scout* started *Support*");
    expect(started.lead).toEqual({ _tag: "bot", botId: scout });
    expect(marked(eventLineWords(teamLine("made-for-room"), pt).runs)).toBe(
      "Criado por *Scout* para *Support*",
    );
  });

  it("leads with a room's glyph once the bot is deleted", () => {
    const words = eventLineWords(teamLine("room-started", BotId.make("gone")), en);
    expect(words.lead).toEqual({ _tag: "icon", icon: "room" });
  });
});

describe("eventLineOpens", () => {
  it("opens the room a team line names from a bot's conversation", () => {
    expect(eventLineOpens(teamLine("room-started"), inConversation)).toEqual({
      _tag: "room",
      roomId: support,
    });
    expect(eventLineOpens(teamLine("made-for-room"), inConversation)).toEqual({
      _tag: "room",
      roomId: support,
    });
  });

  it("opens nothing from the room itself, nor for a room deleted since", () => {
    expect(eventLineOpens(teamLine("room-started"), inSupport)).toBeNull();
    const deleted: LineSetting = { room: null, roomName: () => null };
    expect(eventLineOpens(teamLine("made-for-room"), deleted)).toBeNull();
  });

  it("opens the teammate conversation, or lists the teammates of a line with several", () => {
    const first = sent();
    expect(eventLineOpens(teammates(first, received()), inConversation)).toEqual({
      _tag: "pair",
      pair: { peer: wren, botIds: [scout, wren], first: first.id, count: 2 },
    });
    const fromPip = received("pip");
    expect(eventLineOpens(teammates(first, fromPip), inConversation)).toEqual({
      _tag: "pairs",
      pairs: [
        { peer: wren, botIds: [scout, wren], first: first.id, count: 1 },
        { peer: pip, botIds: [pip, scout], first: fromPip.id, count: 1 },
      ],
    });
  });

  it("opens the routine, or the routines, and nothing for a deleted routine", () => {
    expect(eventLineOpens(routine("paused"), inConversation)).toEqual({
      _tag: "routine",
      routineId: RoutineId.make("digest"),
    });
    expect(eventLineOpens(routine("deleted"), inConversation)).toBeNull();
    const deleted = [routineChange("deleted"), routineChange("deleted", "bills")] as const;
    expect(eventLineOpens({ _tag: "routines", changes: deleted }, inConversation)).toEqual({
      _tag: "routines",
      changes: deleted,
    });
  });
});

describe("handoffMarks", () => {
  it("marks a teammate message urgent, then says where it stands", () => {
    expect(handoffMarks({ urgent: true, state: "unconfirmed" }, en.i18n)).toEqual([
      { text: "Urgent", tone: "waiting" },
      { text: "Not confirmed", tone: "quiet" },
    ]);
    expect(handoffMarks({ urgent: false, state: "sent" }, en.i18n)).toEqual([]);
  });
});
