// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, HandoffEntry, RoutineChangeEntry } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type { EventLine, RoutineChanges } from "../presentation/eventLine.ts";
import { scheduleInWords } from "./schedule.ts";
import type { PresentationContext } from "./status.ts";

/** The glyph a line leads with when no bot's face does. */
export type EventIcon = "routine" | "webhook" | "paused" | "deleted" | "message";

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

/** Where a teammate message stands, when that is anything but sent. */
function stateMark(entry: HandoffEntry, i18n: I18n): EventMark | null {
  switch (entry.state) {
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
export function handoffMarks(entry: HandoffEntry, i18n: I18n): ReadonlyArray<EventMark> {
  const state = stateMark(entry, i18n);
  return [
    ...(entry.urgent ? [{ text: i18n.t("handoff.urgent"), tone: "waiting" } as const] : []),
    ...(state === null ? [] : [state]),
  ];
}

/** One teammate message, as the messages it opens head it: "To Wren", "From Scout". */
export function handoffHeading(entry: HandoffEntry, peerName: string, i18n: I18n): string {
  return entry.direction === "sent"
    ? i18n.t("eventLine.to", { name: peerName })
    : i18n.t("eventLine.from", { name: peerName });
}

/**
 * A routine of a line that tells several, as their list says it under its
 * name: when it runs, as the change saved it, in words, or the expression
 * itself when there are none. Null for one deleted, which runs no more.
 */
export function routineChangeDetail(
  change: RoutineChangeEntry,
  ctx: PresentationContext,
): string | null {
  if (change.change === "deleted") return null;
  const { trigger } = change;
  return scheduleInWords(trigger, ctx) ?? (trigger._tag === "schedule" ? trigger.cron : null);
}

function handoffWords(
  line: Extract<EventLine, { _tag: "handoff" }>,
  ctx: PresentationContext,
): Omit<EventLineWords, "label"> {
  const { i18n } = ctx;
  const { entry } = line;
  const peerName = ctx.botName(line.peer);
  const key =
    entry.direction === "sent"
      ? entry.urgent
        ? "eventLine.urgentMessageTo"
        : "eventLine.messageTo"
      : entry.urgent
        ? "eventLine.urgentMessageFrom"
        : "eventLine.messageFrom";
  return {
    // A deleted teammate has no face to show.
    lead: peerName === null ? { _tag: "icon", icon: "message" } : { _tag: "bot", botId: line.peer },
    runs: runsOf(i18n.parts<typeof key, Slot<"name">>(key, { name: NAME }), {
      name: peerName ?? i18n.t("eventLine.deletedBot"),
    }),
    // Urgent is in the sentence; how the message stands follows it.
    status: stateMark(entry, i18n),
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
    case "handoff":
      return handoffWords(line, ctx);
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
  }
}
