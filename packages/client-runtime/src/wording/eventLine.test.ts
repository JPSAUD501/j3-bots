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
import { at, context } from "../../test/fixtures.ts";
import { type EventLine, eventLineOpens } from "../presentation/eventLine.ts";
import { eventLineWords, type EventRun, handoffHeading, handoffMarks } from "./eventLine.ts";

const scout = BotId.make("scout");
const wren = BotId.make("wren");
const names = { scout: "Scout", wren: "Wren" };
const en = context("2026-11-20T12:00:00Z", "en", names);
const pt = context("2026-11-20T12:00:00Z", "pt-BR", names);

let order = 0;
const handoff = (extra: Partial<HandoffEntry> = {}): HandoffEntry => {
  order += 1;
  return {
    _tag: "handoff",
    id: EntryId.make(`h${order}`),
    order: EntryOrder.make(order),
    author: { _tag: "bot", botId: scout },
    createdAt: at("2026-11-20T11:00:00Z"),
    recipientId: wren,
    direction: "sent",
    text: "Can you check the build?",
    urgent: false,
    state: "sent",
    ...extra,
  };
};
const received = (extra: Partial<HandoffEntry> = {}) =>
  handoff({
    author: { _tag: "bot", botId: wren },
    recipientId: scout,
    direction: "received",
    ...extra,
  });
const line = (entry: HandoffEntry): EventLine => ({ _tag: "handoff", peer: wren, entry });
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
  it("says which way a teammate message went, with the teammate's name strong and face first", () => {
    const sent = eventLineWords(line(handoff()), en);
    expect(marked(sent.runs)).toBe("Message to *Wren*");
    expect(sent.lead).toEqual({ _tag: "bot", botId: wren });
    expect(marked(eventLineWords(line(received({ urgent: true })), pt).runs)).toBe(
      "Mensagem urgente de *Wren*",
    );
  });

  it("adds where a message stands, and reads it as part of the sentence", () => {
    const words = eventLineWords(line(handoff({ state: "not-delivered" })), en);
    expect(words.status).toEqual({ text: "Not delivered", tone: "blocked" });
    expect(words.label).toBe("Message to Wren, Not delivered");
    expect(eventLineWords(line(handoff({ urgent: true })), en).status).toBeNull();
  });

  it("names a deleted teammate as such, with a glyph for its face", () => {
    const words = eventLineWords(line(handoff()), context("2026-11-20T12:00:00Z", "en"));
    expect(words.label).toBe("Message to a deleted bot");
    expect(words.lead).toEqual({ _tag: "icon", icon: "message" });
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
  it("opens the message, the routine, or the routines, and nothing for a deleted routine", () => {
    const sent = handoff();
    expect(eventLineOpens(line(sent))).toEqual({ _tag: "message", peer: wren, entry: sent });
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

describe("a teammate message in full", () => {
  it("is headed by its direction and carries its marks", () => {
    expect(handoffHeading(received(), "Wren", pt.i18n)).toBe("De Wren");
    expect(handoffMarks(handoff({ urgent: true, state: "unconfirmed" }), en.i18n)).toEqual([
      { text: "Urgent", tone: "waiting" },
      { text: "Not confirmed", tone: "quiet" },
    ]);
  });
});
