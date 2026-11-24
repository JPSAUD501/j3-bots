// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  EntryOrder,
  type HandoffEntry,
  type RoutineChangeEntry,
  RoutineId,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, handoff } from "../../test/fixtures.ts";
import { type EventLine, eventLineOpens } from "../presentation/eventLine.ts";
import { buildTimeline } from "../presentation/timeline.ts";
import { eventLineWords, type EventRun, handoffMarks } from "./eventLine.ts";

const scout = BotId.make("scout");
const wren = BotId.make("wren");
const pip = BotId.make("pip");
const names = { scout: "Scout", wren: "Wren", pip: "Pip" };
const en = context("2026-11-20T12:00:00Z", "en", names);
const pt = context("2026-11-20T12:00:00Z", "pt-BR", names);

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

describe("eventLineOpens", () => {
  it("opens the teammate conversation, or lists the teammates of a line with several", () => {
    const first = sent();
    expect(eventLineOpens(teammates(first, received()))).toEqual({
      _tag: "pair",
      pair: { peer: wren, botIds: [scout, wren], first: first.id, count: 2 },
    });
    const fromPip = received("pip");
    expect(eventLineOpens(teammates(first, fromPip))).toEqual({
      _tag: "pairs",
      pairs: [
        { peer: wren, botIds: [scout, wren], first: first.id, count: 1 },
        { peer: pip, botIds: [pip, scout], first: fromPip.id, count: 1 },
      ],
    });
  });

  it("opens the routine, or the routines, and nothing for a deleted routine", () => {
    expect(eventLineOpens(routine("paused"))).toEqual({
      _tag: "routine",
      routineId: RoutineId.make("digest"),
    });
    expect(eventLineOpens(routine("deleted"))).toBeNull();
    const deleted = [routineChange("deleted"), routineChange("deleted", "bills")] as const;
    expect(eventLineOpens({ _tag: "routines", changes: deleted })).toEqual({
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
