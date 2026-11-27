// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, HandoffState } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type {
  EventLine,
  RoutineChange,
  RoutineChanges,
  TeammateRun,
} from "../presentation/eventLine.ts";
import { teamNoticeLine } from "./pairs.ts";
import { eventInWords, eventStopText, scheduleInWords } from "./schedule.ts";
import type { PresentationContext } from "./status.ts";

/** The glyph a line leads with when no bot's face does. */
export type EventIcon = "routine" | "webhook" | "paused" | "deleted" | "message" | "room";

/** What a line leads with: the other bot's face, or a glyph. */
export type EventLead =
  | { readonly _tag: "bot"; readonly botId: BotId }
  | { readonly _tag: "icon"; readonly icon: EventIcon };

/** A stretch of the sentence; a name or a title is `strong`, drawn in medium weight. */
export interface EventRun {
  readonly text: string;
  readonly strong: boolean;
  /** Where it starts in the sentence, which tells it from the other runs. */
  readonly at: number;
}

/** A word on how something stands, after the sentence: `blocked` when it went wrong. */
export interface EventMark {
  readonly text: string;
  readonly tone: "waiting" | "blocked" | "quiet";
}

export interface EventLineWords {
  readonly lead: EventLead;
  /** The sentence, in runs. */
  readonly runs: ReadonlyArray<EventRun>;
  /** How it stands, when that is worth a word on the line itself. */
  readonly status: EventMark | null;
  /** The sentence and its status as one, as a screen reader reads the line. */
  readonly label: string;
}

/** Where a sentence's value goes, so it comes back apart from the words around it. */
interface Slot<K extends string> {
  readonly key: K;
}
const NAME: Slot<"name"> = { key: "name" };
const BOT: Slot<"bot"> = { key: "bot" };

/** A sentence split around its values, each value a strong run. */
const runsOf = <K extends string>(
  parts: ReadonlyArray<string | Slot<K>>,
  values: Readonly<Record<K, string>>,
): ReadonlyArray<EventRun> => {
  const runs: EventRun[] = [];
  let at = 0;
  for (const part of parts) {
    const text = typeof part === "string" ? part : values[part.key];
    runs.push({ text, strong: typeof part !== "string", at });
    at += text.length;
  }
  return runs;
};

const textOf = (runs: ReadonlyArray<EventRun>) => runs.map((run) => run.text).join("");

/** A teammate message's urgency and where it stands: a card in a bot's conversation, or a message between two. */
interface TeammateMessageMarks {
  readonly urgent: boolean;
  readonly state: HandoffState;
}

/** Where a teammate message stands, when that is anything but sent. */
function stateMark(state: HandoffState, i18n: I18n): EventMark | null {
  switch (state) {
    case "sent":
      return null;
    case "not-delivered":
      return { text: i18n.t("handoff.notDelivered"), tone: "blocked" };
    case "stopped":
      return { text: i18n.t("handoff.stopped"), tone: "quiet" };
    case "unconfirmed":
      return { text: i18n.t("handoff.unconfirmed"), tone: "quiet" };
  }
}

/** The marks a teammate message carries: urgent, and where it stands (`stateMark`). */
export function handoffMarks(message: TeammateMessageMarks, i18n: I18n): ReadonlyArray<EventMark> {
  const state = stateMark(message.state, i18n);
  return [
    ...(message.urgent ? [{ text: i18n.t("handoff.urgent"), tone: "waiting" } as const] : []),
    ...(state === null ? [] : [state]),
  ];
}

/**
 * A routine of a line that tells several, as their list says it under its
 * name: when it runs, as the change saved it, in words, or the expression
 * itself when there are none. Null for one deleted, which runs no more.
 */
export function routineChangeDetail(
  change: RoutineChange,
  ctx: PresentationContext,
): string | null {
  if (change.change === "deleted") return null;
  if (change._tag === "event-routine-change") {
    return eventInWords(change.trigger, change.connector, ctx.i18n);
  }
  const { trigger } = change;
  return scheduleInWords(trigger, ctx) ?? (trigger._tag === "schedule" ? trigger.cron : null);
}

type RunKey = "teammates.wrote" | "teammates.heard" | "teammates.heardSeveral" | "teammates.talked";

/** The sentence a run's line says, by what the bot did in it. */
const runKey = (run: TeammateRun): RunKey => {
  switch (run.direction) {
    case "sent":
      return "teammates.wrote";
    case "received":
      return run.pairs.length === 1 ? "teammates.heard" : "teammates.heardSeveral";
    case "both":
      return "teammates.talked";
  }
};
const NAMES: Slot<"names"> = { key: "names" };

/**
 * A run of teammate messages: "Wrote to Wren", "Wren wrote", "Talked with
 * Wren and Pip · 4 messages", each teammate's name strong, led by the first
 * one's face. Its status counts the messages that never reached their
 * teammate.
 */
function teammateWords(run: TeammateRun, ctx: PresentationContext): Omit<EventLineWords, "label"> {
  const { i18n } = ctx;
  const [first] = run.pairs;
  const sentence = i18n.pluralParts<RunKey, Slot<"names">>(runKey(run), run.entries.length, {
    names: NAMES,
  });
  // A deleted teammate that opens the sentence is named as a sentence starts.
  const opens = sentence[0] === NAMES;
  const names = run.pairs.map(
    (pair, index) =>
      ctx.botName(pair.peer) ??
      i18n.t(opens && index === 0 ? "bot.unknown" : "eventLine.deletedBot"),
  );
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).formatToParts(names);
  const runs: EventRun[] = [];
  let at = 0;
  const add = (text: string, strong: boolean) => {
    runs.push({ text, strong, at });
    at += text.length;
  };
  for (const part of sentence) {
    if (typeof part === "string") add(part, false);
    else for (const item of list) add(item.value, item.type === "element");
  }
  return {
    // A deleted teammate has no face to show.
    lead:
      ctx.botName(first.peer) === null
        ? { _tag: "icon", icon: "message" }
        : { _tag: "bot", botId: first.peer },
    runs,
    status:
      run.undelivered === 0
        ? null
        : { text: i18n.plural("teammates.undelivered", run.undelivered), tone: "blocked" },
  };
}

function routineWords(
  changes: RoutineChanges,
  ctx: PresentationContext,
): Omit<EventLineWords, "label"> {
  const { i18n } = ctx;
  const [first, ...rest] = changes;
  const { change, trigger, name } = first;
  const icon: EventIcon =
    change === "deleted"
      ? "deleted"
      : change === "paused"
        ? "paused"
        : rest.length === 0 && trigger._tag === "webhook"
          ? "webhook"
          : "routine";
  const lead = { _tag: "icon", icon } as const;
  if (rest.length === 0) {
    const key = {
      created: "eventLine.routineCreated",
      updated: "eventLine.routineUpdated",
      paused: "eventLine.routinePaused",
      resumed: "eventLine.routineResumed",
      deleted: "eventLine.routineDeleted",
    } as const satisfies Record<typeof change, string>;
    const parts = i18n.parts<(typeof key)[typeof change], Slot<"name">>(key[change], {
      name: NAME,
    });
    return { lead, runs: runsOf(parts, { name }), status: null };
  }
  const key = {
    created: "eventLine.routinesCreated",
    updated: "eventLine.routinesUpdated",
    paused: "eventLine.routinesPaused",
    resumed: "eventLine.routinesResumed",
    deleted: "eventLine.routinesDeleted",
  } as const satisfies Record<typeof change, string>;
  // A run is two routines or more. Several have no one name to stand out; the line opens them, named.
  return {
    lead,
    runs: [{ text: i18n.plural(key[change], changes.length), strong: false, at: 0 }],
    status: null,
  };
}

/** What a line says and leads with. */
export function eventLineWords(line: EventLine, ctx: PresentationContext): EventLineWords {
  const words = linePieces(line, ctx);
  const sentence = textOf(words.runs);
  return {
    ...words,
    label:
      words.status === null
        ? sentence
        : ctx.i18n.t("eventLine.withStatus", { line: sentence, status: words.status.text }),
  };
}

function linePieces(line: EventLine, ctx: PresentationContext): Omit<EventLineWords, "label"> {
  const { i18n } = ctx;
  switch (line._tag) {
    case "teammates":
      return teammateWords(line.run, ctx);
    case "routines":
      return routineWords(line.changes, ctx);
    case "routine-paused": {
      const parts = i18n.parts<"eventLine.routineUnreadable", Slot<"name">>(
        "eventLine.routineUnreadable",
        { name: NAME },
      );
      return {
        lead: { _tag: "icon", icon: "paused" },
        runs: runsOf(parts, { name: line.entry.notice.name }),
        status: null,
      };
    }
    case "event-routine": {
      const { entry } = line;
      if (entry.change !== "stopped") {
        // A change this client does not know: the routine changed, in some way.
        const parts = i18n.parts<"eventLine.routineUpdated", Slot<"name">>(
          "eventLine.routineUpdated",
          { name: NAME },
        );
        return {
          lead: { _tag: "icon", icon: "routine" },
          runs: runsOf(parts, { name: entry.name }),
          status: null,
        };
      }
      const parts = i18n.parts<"eventLine.routineStopped", Slot<"name">>(
        "eventLine.routineStopped",
        { name: NAME },
      );
      const reason = eventStopText(entry.stopped ?? "unknown", entry.connector, i18n);
      return {
        lead: { _tag: "icon", icon: "paused" },
        runs: runsOf(parts, { name: entry.name }),
        status: reason === null ? null : { text: reason, tone: "blocked" },
      };
    }
    case "operator-named": {
      const { botId, name } = line.entry.notice;
      const bot = ctx.botName(botId);
      const parts = i18n.parts<"eventLine.operatorNamed", Slot<"bot" | "name">>(
        "eventLine.operatorNamed",
        { bot: BOT, name: NAME },
      );
      return {
        lead: bot === null ? { _tag: "icon", icon: "message" } : { _tag: "bot", botId },
        runs: runsOf(parts, { name, bot: bot ?? i18n.t("bot.unknown") }),
        status: null,
      };
    }
    case "team": {
      // "Scout started Support", "Made by Scout for Support": the bot's and the room's names strong.
      const { notice } = line.entry;
      const runs: EventRun[] = [];
      let at = 0;
      for (const part of teamNoticeLine(notice, ctx).parts) {
        const text = typeof part === "string" ? part : part.name;
        runs.push({ text, strong: typeof part !== "string", at });
        at += text.length;
      }
      return {
        lead:
          notice.botId === null || ctx.botName(notice.botId) === null
            ? { _tag: "icon", icon: "room" }
            : { _tag: "bot", botId: notice.botId },
        runs,
        status: null,
      };
    }
  }
}
